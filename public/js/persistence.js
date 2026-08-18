(function (App) {
  'use strict';

  // localStorage is authoritative. Every mutation lands here synchronously
  // before the UI acknowledges it, so a crash or reload never loses a pick that
  // was already entered -- the Sheets copy is the off-machine replica, not the
  // primary record.

  const STATE_KEY = 'sleeperDraftTracker.state.v1';
  const PREFS_KEY = 'sleeperDraftTracker.prefs.v1';
  const LOCK_KEY = 'sleeperDraftTracker.session.v1';
  const LOCK_STALE_MS = 15000;
  const HEARTBEAT_MS = 5000;

  const sessionId = App.utils.uid('sess');
  let quotaWarned = false;

  const Persistence = {
    sessionId,

    save(state) {
      if (!state) return true;
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        return true;
      } catch (err) {
        // A silent localStorage failure is the worst bug this app could have,
        // so make it loud and push the operator toward a file backup.
        if (!quotaWarned) {
          quotaWarned = true;
          console.error('[persistence] save failed', err);
          App.bus?.emit('storage:failed', err);
        }
        return false;
      }
    },

    load() {
      try {
        const raw = localStorage.getItem(STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && Array.isArray(parsed.picks) ? parsed : null;
      } catch (err) {
        console.error('[persistence] load failed', err);
        return null;
      }
    },

    clear() {
      try {
        localStorage.removeItem(STATE_KEY);
      } catch {
        /* nothing useful to do */
      }
    },

    prefs() {
      try {
        return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
      } catch {
        return {};
      }
    },

    setPref(key, value) {
      const prefs = Persistence.prefs();
      prefs[key] = value;
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* preferences are not worth failing over */
      }
      return prefs;
    },

    // --- session lock -------------------------------------------------------
    // Two tabs sharing localStorage with a full-snapshot sync model is a real
    // data-loss path. The second tab goes read-only instead of competing.

    /** Returns true if this tab owns the session. */
    claimSession() {
      const existing = readLock();
      const now = Date.now();
      if (existing && existing.id !== sessionId && now - existing.at < LOCK_STALE_MS) {
        return false;
      }
      writeLock(now);
      return true;
    },

    startHeartbeat() {
      setInterval(() => writeLock(Date.now()), HEARTBEAT_MS);
    },

    releaseSession() {
      const existing = readLock();
      if (existing && existing.id === sessionId) {
        try {
          localStorage.removeItem(LOCK_KEY);
        } catch {
          /* best effort */
        }
      }
    },

    /** Forcibly take over from a tab that was left open elsewhere. */
    takeoverSession() {
      writeLock(Date.now());
    },
  };

  function readLock() {
    try {
      return JSON.parse(localStorage.getItem(LOCK_KEY));
    } catch {
      return null;
    }
  }

  function writeLock(at) {
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ id: sessionId, at }));
    } catch {
      /* best effort */
    }
  }

  App.persistence = Persistence;
})(window.DraftApp);
