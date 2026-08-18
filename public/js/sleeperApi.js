(function (App) {
  'use strict';

  // Setup-screen convenience only: pull team and manager names out of an
  // existing Sleeper league so the operator doesn't type twelve of them. Called
  // directly from the browser -- Sleeper's read API is public and CORS-open.
  //
  // Every call here is optional and non-blocking. Setup must complete fine with
  // no network at all, so failures return a message rather than throwing.

  const BASE = 'https://api.sleeper.app/v1';
  const TIMEOUT_MS = 8000;

  async function get(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Sleeper returned HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  App.sleeper = {
    async leaguesForUser(username, season) {
      const user = await get(`/user/${encodeURIComponent(username.trim())}`);
      if (!user || !user.user_id) {
        return { ok: false, message: `No Sleeper user named "${username}".` };
      }
      const year = season || String(new Date().getFullYear());
      const leagues = await get(`/user/${user.user_id}/leagues/nfl/${year}`);
      if (!leagues || !leagues.length) {
        return { ok: false, message: `That user has no ${year} NFL leagues.` };
      }
      return {
        ok: true,
        leagues: leagues.map((l) => ({
          id: l.league_id,
          name: l.name,
          teams: l.total_rosters,
        })),
      };
    },

    async teamsForLeague(leagueId) {
      const users = await get(`/league/${encodeURIComponent(leagueId.trim())}/users`);
      if (!users || !users.length) {
        return { ok: false, message: 'No league found with that ID.' };
      }
      return {
        ok: true,
        teams: users.map((u) => ({
          name: u.metadata?.team_name || u.display_name || 'Team',
          manager: u.display_name || '',
          sleeperUserId: u.user_id,
        })),
      };
    },
  };
})(window.DraftApp);
