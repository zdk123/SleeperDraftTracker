(function (App) {
  'use strict';

  const { el, clear, money } = App.utils;
  const { store } = App;

  // The shared screen. Everything here is sized to be read from across a room,
  // so it shows only what the room actually cares about: who has money left,
  // what each team has bought, and what just went.
  //
  // Deliberately NOT a full slot grid -- a dozen empty bench rows per team is a
  // wall of dashes that pushes the real information off screen. Filled spots
  // are listed; what's still needed is summarised in one line underneath.

  const RECENT_COUNT = 6;

  /**
   * Team columns are narrow (a 12-team league leaves ~140px), so the board
   * shows surnames the way a physical draft board does -- "Jefferson", not
   * "Justin Jefferson". The position tag beside it resolves the rare clash, and
   * the full name is still in the tooltip, the pick list, and every export.
   */
  function boardName(fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length < 2) return fullName;
    // "SF Defense" and the like read better whole.
    if (/^(defense|dst|d\/st)$/i.test(parts[parts.length - 1])) return fullName;
    const last = parts.slice(1).join(' ');
    // Drop a trailing suffix: "Marvin Harrison Jr." -> "Harrison Jr."
    return last;
  }

  function needsLine(teamId) {
    const open = store.openSlotCodes(teamId);
    if (!open.length) return null;
    // Collapse BN1..BN6 into "BN x6" rather than listing each one.
    const counts = new Map();
    for (const slot of open) counts.set(slot.slotKey, (counts.get(slot.slotKey) || 0) + 1);
    const parts = [];
    for (const [key, count] of counts) parts.push(count > 1 ? `${key}×${count}` : key);
    return parts.join(' · ');
  }

  function teamColumn(team, nominatorId) {
    const summary = store.teamSummary(team.id);
    const picks = store.picksFor(team.id).slice().sort((a, b) => b.price - a.price);
    const pctSpent = summary.budget ? Math.min(100, (summary.spent / summary.budget) * 100) : 0;
    const needs = needsLine(team.id);
    const broke = summary.open > 0 && summary.maxBid <= store.minBid();
    const nominating = team.id === nominatorId;

    return el('div', {
      class:
        'team-col' +
        (summary.open === 0 ? ' is-full' : '') +
        (nominating ? ' is-nominating' : ''),
    }, [
      nominating ? el('div', { class: 'team-col__flag', text: 'NOMINATING' }) : null,
      el('div', { class: 'team-col__head' }, [
        el('div', { class: 'team-col__name', text: team.name, title: team.name }),
        el('div', { class: 'team-col__budget' }, [
          el('span', { class: `team-col__left${broke ? ' is-low' : ''}`, text: money(summary.remaining) }),
          el('span', { class: 'team-col__of', text: `of ${money(summary.budget)}` }),
        ]),
        el('div', { class: 'meter', title: `${money(summary.spent)} spent` }, [
          el('div', { class: 'meter__fill', style: `width:${pctSpent}%` }),
        ]),
        el('div', { class: 'team-col__sub' }, [
          el('span', { text: `${summary.filled}/${summary.filled + summary.open}` }),
          el('span', { text: summary.open ? `max ${money(summary.maxBid)}` : 'full' }),
        ]),
      ]),

      picks.length
        ? el(
            'ul',
            { class: 'team-col__picks' },
            picks.map((pick) =>
              el('li', { class: 'pick', title: `${pick.playerName} — ${pick.slot}` }, [
                el('span', { class: `pick__pos pos-${pick.position}`, text: pick.position }),
                el('span', { class: 'pick__player', text: boardName(pick.playerName) }),
                el('span', { class: 'pick__price', text: money(pick.price) }),
              ])
            )
          )
        : el('div', { class: 'team-col__empty', text: 'nothing yet' }),

      needs ? el('div', { class: 'team-col__needs', title: 'Still to fill', text: needs }) : null,
    ]);
  }

  function recentStrip() {
    const picks = store.get().picks.slice(-RECENT_COUNT).reverse();
    if (!picks.length) {
      return el('div', { class: 'recent recent--empty' }, [
        el('span', { class: 'muted', text: 'No picks yet. Enter the first one above.' }),
      ]);
    }
    return el(
      'div',
      { class: 'recent' },
      picks.map((pick, i) => {
        const team = store.teamById(pick.teamId);
        return el('div', { class: `recent__item${i === 0 ? ' is-newest' : ''}` }, [
          el('span', { class: 'recent__price', text: money(pick.price) }),
          el('span', { class: 'recent__player', text: pick.playerName }),
          el('span', { class: 'recent__pos', text: pick.position }),
          el('span', { class: 'recent__team', text: team ? team.name : '' }),
        ]);
      })
    );
  }

  function summaryBar(nominatorId) {
    const state = store.get();
    const spent = state.picks.reduce((sum, p) => sum + p.price, 0);
    const totalBudget = state.teams.length * state.settings.budgetPerTeam;
    const totalSlots = state.teams.length * store.totalSlots();
    const nominator = nominatorId ? store.teamById(nominatorId) : null;
    return el('div', { class: 'summary' }, [
      nominator
        ? el('div', { class: 'summary__nominating' }, [
            el('span', { class: 'summary__lbl', text: 'nominating' }),
            el('span', { class: 'summary__team', text: nominator.name }),
          ])
        : null,
      el('div', { class: 'summary__stat' }, [
        el('span', { class: 'summary__num', text: String(state.picks.length) }),
        el('span', { class: 'summary__lbl', text: `of ${totalSlots} picks` }),
      ]),
      el('div', { class: 'summary__stat' }, [
        el('span', { class: 'summary__num', text: money(spent) }),
        el('span', { class: 'summary__lbl', text: `of ${money(totalBudget)} spent` }),
      ]),
      el('div', { class: 'summary__stat' }, [
        el('span', {
          class: 'summary__num',
          text: state.picks.length ? money(Math.max(...state.picks.map((p) => p.price))) : '—',
        }),
        el('span', { class: 'summary__lbl', text: 'top bid' }),
      ]),
    ]);
  }

  App.views = App.views || {};
  App.views.board = {
    render(container) {
      clear(container);
      const teams = store.get().teams;
      const nominatorId = store.currentNominator();
      const board = el('div', { class: 'board' }, teams.map((t) => teamColumn(t, nominatorId)));
      // Fit every team on one row: a wrapped final row of two columns reads as
      // a mistake on a shared screen.
      board.style.gridTemplateColumns = `repeat(${teams.length}, minmax(0, 1fr))`;
      container.append(summaryBar(nominatorId), recentStrip(), board);
    },
  };
})(window.DraftApp);
