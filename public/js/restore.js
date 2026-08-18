(function (App) {
  'use strict';

  const { store, persistence, sync } = App;

  // What "resume" means when state can live in two places. Local is
  // authoritative in normal operation; the sheet only wins when local is gone
  // or clearly behind, and the operator is always the one who decides.

  App.restore = {
    /** Draft saved in this browser, if any. */
    local() {
      return persistence.load();
    },

    /**
     * Compares the local draft against the sheet's copy.
     * @returns {'local-only'|'remote-only'|'match'|'local-ahead'|'remote-ahead'|'different-draft'|'no-remote'}
     */
    async compare(localState) {
      let remote;
      try {
        remote = await sync.fetchRemote();
      } catch {
        return { verdict: 'no-remote', remote: null };
      }

      if (!remote.found) {
        return { verdict: localState ? 'local-only' : 'remote-only', remote: null };
      }
      if (!localState) return { verdict: 'remote-only', remote };
      if (localState.draftId !== remote.state.draftId) {
        return { verdict: 'different-draft', remote };
      }
      if (localState.revision > remote.revision) return { verdict: 'local-ahead', remote };
      if (localState.revision < remote.revision) return { verdict: 'remote-ahead', remote };
      return { verdict: 'match', remote };
    },

    /** Adopts the sheet's copy, bumping past its revision so the next sync sticks. */
    adoptRemote(remote) {
      const next = remote.state;
      next.revision = Math.max(Number(remote.revision) || 0, Number(next.revision) || 0) + 1;
      store.load(next, 'restore');
      persistence.save(store.get());
      return next;
    },
  };
})(window.DraftApp);
