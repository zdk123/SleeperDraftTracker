(function (App) {
  'use strict';

  const { store, utils } = App;

  // Everything the commissioner needs to re-enter results into Sleeper by hand
  // afterward, plus a raw JSON backup that can be re-imported into this app.

  function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(rows) {
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  /**
   * Filenames carry the draft's key, so exports from two drafts (or two points
   * in one draft) never overwrite each other in the downloads folder.
   */
  function stamp() {
    const state = store.get();
    const key = (state && (state.draftKey || state.draftId)) || 'draft';
    return key.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  }

  App.exporter = {
    picksCsv() {
      const state = store.get();
      const rows = [
        ['Pick #', 'Timestamp', 'Player', 'Pos', 'NFL Team', 'Fantasy Team', 'Manager', 'Price', 'Slot'],
      ];
      state.picks.forEach((pick, i) => {
        const team = store.teamById(pick.teamId);
        rows.push([
          i + 1,
          pick.timestamp,
          pick.playerName,
          pick.position,
          pick.nflTeam,
          team ? team.name : '',
          team ? team.manager : '',
          pick.price,
          pick.slot,
        ]);
      });
      return toCsv(rows);
    },

    rostersCsv() {
      const state = store.get();
      const slots = store.expandSlots();
      const header = ['Slot'];
      for (const team of state.teams) header.push(team.name, '$');
      const rows = [header];

      const bySlot = new Map(state.picks.map((p) => [`${p.teamId}::${p.slot}`, p]));
      for (const slot of slots) {
        const row = [slot.label];
        for (const team of state.teams) {
          const pick = bySlot.get(`${team.id}::${slot.code}`);
          row.push(pick ? pick.playerName : '', pick ? pick.price : '');
        }
        rows.push(row);
      }

      const totals = ['TOTAL'];
      for (const team of state.teams) totals.push('', store.teamSummary(team.id).spent);
      rows.push(totals);
      return toCsv(rows);
    },

    /** Plain text grouped by team -- the version to read off while typing into Sleeper. */
    rostersText() {
      const state = store.get();
      const title = state.name ? `${state.name} — auction draft results` : 'AUCTION DRAFT RESULTS';
      const lines = [title, new Date().toLocaleString(), ''];

      for (const team of state.teams) {
        const summary = store.teamSummary(team.id);
        lines.push(`${team.name}${team.manager ? ` (${team.manager})` : ''}`);
        lines.push(
          `  spent ${utils.money(summary.spent)} of ${utils.money(summary.budget)} · ` +
            `${summary.filled} players · ${utils.money(summary.remaining)} left`
        );
        const picks = store.picksFor(team.id).slice().sort((a, b) => b.price - a.price);
        if (!picks.length) lines.push('  (no players)');
        for (const pick of picks) {
          const label = `${pick.playerName} (${pick.position}${pick.nflTeam ? `-${pick.nflTeam}` : ''})`;
          lines.push(`  ${utils.money(pick.price).padStart(5)}  ${label}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    },

    stateJson() {
      return JSON.stringify(store.get(), null, 2);
    },

    downloadPicksCsv() {
      utils.downloadFile(`${stamp()}-picks.csv`, App.exporter.picksCsv(), 'text/csv');
    },
    downloadRostersCsv() {
      utils.downloadFile(`${stamp()}-rosters.csv`, App.exporter.rostersCsv(), 'text/csv');
    },
    downloadRostersText() {
      utils.downloadFile(`${stamp()}-rosters.txt`, App.exporter.rostersText());
    },
    downloadStateJson() {
      utils.downloadFile(`${stamp()}-backup.json`, App.exporter.stateJson(), 'application/json');
    },
  };
})(window.DraftApp);
