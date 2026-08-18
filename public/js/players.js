(function (App) {
  'use strict';

  // The player list is a static file baked at build time by
  // scripts/build-players.mjs -- ~90KB, no Sleeper call on draft night. Each
  // entry carries a precomputed lowercase search key, so a keystroke is one
  // linear scan over ~1,000 entries with no per-item string work. That's fast
  // enough that a search library would be pure overhead.

  const MAX_RESULTS = 8;

  let players = [];
  let loaded = false;
  let loadError = null;

  App.players = {
    async load() {
      if (loaded) return { ok: true, count: players.length };

      // The single-file build inlines the list, so it works from a plain
      // double-clicked file with no server and no network at all.
      if (window.__PLAYERS__ && Array.isArray(window.__PLAYERS__.players)) {
        players = window.__PLAYERS__.players;
        loaded = true;
        return { ok: true, count: players.length, generatedAt: window.__PLAYERS__.generatedAt };
      }

      try {
        const res = await fetch('data/players.json', { cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        players = data.players || [];
        loaded = true;
        return { ok: true, count: players.length, generatedAt: data.generatedAt };
      } catch (err) {
        // Free-text entry still works, so a failure here never blocks the draft.
        loadError = err;
        console.warn('[players] list unavailable, falling back to free text', err);
        return { ok: false, error: err.message };
      }
    },

    isLoaded() {
      return loaded;
    },

    error() {
      return loadError;
    },

    count() {
      return players.length;
    },

    /** The whole filtered list. Used by the simulation harness. */
    all() {
      return players;
    },

    byId(id) {
      return players.find((p) => p.id === id) || null;
    },

    /**
     * Ranks prefix matches above substring matches, then by Sleeper's
     * search_rank so recognizable names surface first.
     */
    search(term, { excludeIds } = {}) {
      const q = (term || '').trim().toLowerCase();
      if (!q) return [];

      const starts = [];
      const contains = [];
      for (const p of players) {
        const at = p.k.indexOf(q);
        if (at === -1) continue;
        const entry = { ...p, drafted: excludeIds ? excludeIds.has(p.id) : false };
        if (at === 0 || p.k[at - 1] === ' ') starts.push(entry);
        else contains.push(entry);
        if (starts.length >= MAX_RESULTS * 3) break;
      }

      const rank = (a, b) => (a.r ?? 99999) - (b.r ?? 99999);
      starts.sort(rank);
      contains.sort(rank);
      return starts.concat(contains).slice(0, MAX_RESULTS);
    },
  };
})(window.DraftApp);
