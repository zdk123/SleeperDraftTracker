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

    /** Every draft the spreadsheet knows about, newest activity first. */
    async listRemote() {
      const data = await sync.fetchRemote();
      return data.drafts || [];
    },

    /**
     * Compares the local draft against the sheet's copy of that same draft.
     * @returns {'local-only'|'remote-only'|'match'|'local-ahead'|'remote-ahead'|'no-remote'}
     */
    async compare(localState) {
      let remote;
      try {
        remote = await sync.fetchRemote(localState ? localState.draftKey : null);
      } catch {
        return { verdict: 'no-remote', remote: null };
      }

      if (!remote.found) {
        return { verdict: localState ? 'local-only' : 'remote-only', remote: null, drafts: remote.drafts };
      }
      if (!localState) return { verdict: 'remote-only', remote };
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
