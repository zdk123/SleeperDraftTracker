(function (App) {
  'use strict';

  const { store, persistence, sync } = App;

  // What "resume" means when state can live in two places. Local is
  // authoritative in normal operation; the sheet only wins when local is gone
  // or clearly behind, and the operator is always the one who decides.

  /** The sheet's revision, which travels inside the state it returned. */
  function remoteRevisionOf(remote) {
    return Number(remote && remote.state && remote.state.revision) || 0;
  }

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
     *
     * The revision lives on the state the sheet gave back, not on the envelope
     * around it -- reading it off the envelope silently made every comparison
     * `undefined`, so this reported "match" no matter how far apart the two
     * were. That is the one answer an operator must be able to trust, so pick
     * count is checked too: equal revisions with different picks is a real
     * divergence, not a match.
     *
     * @returns {'local-only'|'remote-only'|'match'|'local-ahead'|'remote-ahead'|'diverged'|'no-remote'}
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

      const localRev = Number(localState.revision) || 0;
      const remoteRev = Number(remoteRevisionOf(remote)) || 0;
      if (localRev > remoteRev) return { verdict: 'local-ahead', remote };
      if (localRev < remoteRev) return { verdict: 'remote-ahead', remote };

      const localPicks = (localState.picks || []).length;
      const remotePicks = ((remote.state && remote.state.picks) || []).length;
      if (localPicks !== remotePicks) return { verdict: 'diverged', remote };
      return { verdict: 'match', remote };
    },

    /** Adopts the sheet's copy, bumping past its revision so the next sync sticks. */
    adoptRemote(remote) {
      const next = remote.state;
      next.revision = Math.max(remoteRevisionOf(remote), Number(next.revision) || 0) + 1;
      store.load(next, 'restore');
      persistence.save(store.get());
      return next;
    },
  };
})(window.DraftApp);
