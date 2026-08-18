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

  function setStatus(next, message) {
    status = next;
    detail = message || '';
    bus.emit('sync:status', Sync.snapshot());
  }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['X-Draft-Token'] = token;
    return h;
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
      const res = await fetch('api/sync', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          state,
          force,
          summary,
          client: persistence.sessionId,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.error?.code === 'stale') {
        lastServerRevision = data.serverRevision || 0;
        setStatus('error', 'The spreadsheet has newer data — open Recover to resolve.');
        bus.emit('sync:stale', data);
        return;
      }

      if (!res.ok || !data.ok) {
        throw Object.assign(new Error(data.error?.message || `HTTP ${res.status}`), {
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

  const schedule = App.utils.debounce((summary) => push({ summary }), DEBOUNCE_MS);

  const Sync = {
    init({ token: t } = {}) {
      token = t || '';
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
      token = t || '';
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

    async fetchRemote() {
      const res = await fetch('api/state', { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }
      return data;
    },

    async health() {
      const res = await fetch('api/health', { headers: headers() });
      return res.json();
    },

    snapshot() {
      return { status, detail, lastSyncedAt, lastServerRevision, dirty, enabled };
    },
  };

  App.sync = Sync;
})(window.DraftApp);
