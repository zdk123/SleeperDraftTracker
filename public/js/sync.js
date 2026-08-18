(function (App) {
  'use strict';

  const { store, persistence, bus } = App;

  // Best-effort replication of local state to the spreadsheet. Never on the
  // critical path: picks are already committed locally before this runs, and a
  // failure here surfaces as a status pill, never as a blocked action.
  //
  // The unit of sync is the whole state, debounced. Queue depth is therefore
  // always 0 or 1 -- a superseded snapshot is simply discarded rather than
  // queued, which makes retries idempotent and undo/edit require no special
  // handling at all.

  const DEBOUNCE_MS = 1500;
  // Ceiling on how long a burst of picks can defer a write. Without it, picks
  // arriving closer together than the debounce keep pushing the sync back and
  // the sheet never gets written -- the sheet would be arbitrarily far behind
  // exactly when the room is moving fastest.
  const MAX_DEFER_MS = 6000;
  const MIN_INTERVAL_MS = 2000;
  const MAX_BACKOFF_MS = 32000;

  let status = 'idle'; // idle | pending | syncing | synced | offline | error | disabled
  let detail = '';
  let lastSyncedAt = null;
  let lastServerRevision = 0;
  let inFlight = false;
  let dirty = false;
  let retryTimer = null;
  let failures = 0;
  let lastAttemptAt = 0;
  let token = '';
  let enabled = true;
  let backendId = App.backends.defaultId();

  function backend() {
    return App.backends.get(backendId);
  }

  function setStatus(next, message) {
    status = next;
    detail = message || '';
    bus.emit('sync:status', Sync.snapshot());
  }

  async function push({ force = false, summary = '' } = {}) {
    if (!enabled || !store.exists()) return;
    if (inFlight) {
      dirty = true;
      return;
    }

    const sinceLast = Date.now() - lastAttemptAt;
    if (sinceLast < MIN_INTERVAL_MS) {
      dirty = true;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => push({ summary }), MIN_INTERVAL_MS - sinceLast);
      return;
    }

    if (!navigator.onLine) {
      dirty = true;
      setStatus('offline', 'Waiting for a connection');
      return;
    }

    inFlight = true;
    dirty = false;
    lastAttemptAt = Date.now();
    setStatus('syncing');

    const state = store.get();
    try {
      const { status: code, data } = await backend().push(state, {
        force,
        summary,
        client: persistence.sessionId,
      });

      // A conflict is never retried automatically -- resolving it means
      // choosing which draft the spreadsheet should hold, which is the
      // operator's call, not ours.
      if (code === 409) {
        lastServerRevision = data.serverRevision || 0;
        const differentDraft = data.error?.code === 'different_draft';
        setStatus(
          'error',
          differentDraft
            ? 'The spreadsheet holds a different draft — open Backup to take it over.'
            : 'The spreadsheet has newer data — open Backup to resolve.'
        );
        bus.emit('sync:conflict', { ...data, differentDraft });
        return;
      }

      if (code >= 400 || !data.ok) {
        throw Object.assign(new Error(data.error?.message || `HTTP ${code}`), {
          code: data.error?.code,
          hint: data.error?.hint,
        });
      }

      failures = 0;
      lastSyncedAt = new Date().toISOString();
      lastServerRevision = data.revision || state.revision;
      setStatus('synced');
    } catch (err) {
      failures += 1;
      dirty = true;
      if (err.code === 'not_configured') {
        // No credentials on the server: local-only is a valid way to run.
        enabled = false;
        setStatus('disabled', 'Saving locally only');
        return;
      }
      const offline = !navigator.onLine || err.name === 'TypeError';
      setStatus(offline ? 'offline' : 'error', err.hint || err.message);

      // Truncated exponential backoff with jitter.
      const wait = Math.min(2 ** failures * 1000 + Math.random() * 500, MAX_BACKOFF_MS);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => push({ summary: 'retry' }), wait);
    } finally {
      inFlight = false;
      if (dirty && status !== 'offline' && status !== 'disabled') {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => push({ summary: 'coalesced' }), MIN_INTERVAL_MS);
      }
    }
  }

  const schedule = App.utils.debounce((summary) => push({ summary }), DEBOUNCE_MS, {
    maxWait: MAX_DEFER_MS,
  });

  const Sync = {
    init({ token: t, backend: id, appsScriptUrl } = {}) {
      Sync.configure({ token: t, backend: id, appsScriptUrl });
      window.addEventListener('online', () => {
        if (dirty) push({ summary: 'back online' });
      });
      window.addEventListener('offline', () => setStatus('offline', 'No connection'));
      // A flush on hide is a cheap safety net when the laptop is closed.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && dirty) push({ summary: 'tab hidden' });
      });
    },

    setToken(t) {
      Sync.configure({ token: t });
    },

    /** Point the sync engine at a backend. Safe to call repeatedly. */
    configure({ token: t, backend: id, appsScriptUrl } = {}) {
      if (t !== undefined) token = t || '';
      if (id) backendId = App.backends.all[id] ? id : backendId;
      if (appsScriptUrl !== undefined) App.backends.all.appsScript.setUrl(appsScriptUrl);
      for (const b of Object.values(App.backends.all)) b.setToken(token);
      // A backend that was switched away from an unconfigured one deserves
      // another chance rather than staying permanently disabled.
      if (!enabled && status === 'disabled') enabled = true;
    },

    backendId() {
      return backendId;
    },

    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) setStatus('disabled', 'Saving locally only');
    },

    /** Called after every state mutation. Marks dirty and debounces a push. */
    notify(reason) {
      if (!enabled) return;
      dirty = true;
      if (status !== 'syncing') setStatus('pending');
      schedule(reason);
    },

    flushNow(summary) {
      schedule.cancel();
      return push({ summary: summary || 'manual' });
    },

    forceOverwrite() {
      schedule.cancel();
      return push({ force: true, summary: 'forced overwrite' });
    },

    /** Without a key: the list of drafts. With one: that draft's full state. */
    async fetchRemote(draftKey) {
      const { status: code, data } = draftKey
        ? await backend().load(draftKey)
        : await backend().list();
      if (code >= 400 || !data.ok) {
        throw new Error(data.error?.message || `HTTP ${code}`);
      }
      return data;
    },

    async health() {
      const { data } = await backend().health();
      return data;
    },

    snapshot() {
      return { status, detail, lastSyncedAt, lastServerRevision, dirty, enabled, backend: backendId };
    },
  };

  App.sync = Sync;
})(window.DraftApp);
