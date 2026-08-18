(function (App) {
  'use strict';

  const { el, clear, money } = App.utils;
  const { store } = App;

  // What a guest sees on their phone. The big board across the room already
  // shows the league; this shows *your team*, which is the thing you actually
  // keep wanting to check and the thing hardest to read from a sofa.
  //
  // Unlike the shared board, this lists empty roster spots too. On a TV a dozen
  // blank bench rows per team is a wall of dashes that buries the real
  // information; on a phone, with one team to show and a column of vertical
  // room, "what do I still need" is most of the question.

  const RECENT_COUNT = 8;

  function ago(ms) {
    if (ms === null || ms === undefined) return 'never';
    const s = Math.round(ms / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    return m === 1 ? 'a minute ago' : `${m} min ago`;
  }

  /** Every roster spot for a team, filled or not, in configured order. */
  function rosterRows(teamId) {
    const picks = store.picksFor(teamId);
    const bySlot = new Map(picks.map((p) => [p.slot, p]));
    const rows = store.expandSlots().map((slot) => ({ slot, pick: bySlot.get(slot.code) || null }));

    // A pick whose slot no longer matches the roster shape (edited settings, a
    // restored draft) would otherwise vanish from this list entirely.
    const shown = new Set(rows.filter((r) => r.pick).map((r) => r.pick.id));
    for (const pick of picks) {
      if (!shown.has(pick.id)) rows.push({ slot: { code: pick.slot || '—', label: pick.slot || '—' }, pick });
    }
    return rows;
  }

  function myTeamCard(teamId) {
    const team = store.teamById(teamId);
    if (!team) return el('div', { class: 'muted', text: 'That team is no longer in this draft.' });

    const s = store.teamSummary(team.id);
    const pctSpent = s.budget ? Math.min(100, (s.spent / s.budget) * 100) : 0;

    return el('section', { class: 'vcard vcard--mine' }, [
      el('div', { class: 'vcard__head' }, [
        el('h1', { class: 'vcard__team', text: team.name }),
        el('div', { class: 'vcard__money' }, [
          el('span', { class: 'vcard__left', text: money(s.remaining) }),
          el('span', { class: 'vcard__of', text: `left of ${money(s.budget)}` }),
        ]),
      ]),
      el('div', { class: 'meter' }, [el('div', { class: 'meter__fill', style: `width:${pctSpent}%` })]),
      el('div', { class: 'vcard__stats' }, [
        el('div', { class: 'vstat' }, [
          el('span', { class: 'vstat__num', text: s.open ? money(s.maxBid) : '—' }),
          el('span', { class: 'vstat__lbl', text: 'max bid' }),
        ]),
        el('div', { class: 'vstat' }, [
          el('span', { class: 'vstat__num', text: `${s.filled}/${s.filled + s.open}` }),
          el('span', { class: 'vstat__lbl', text: 'spots filled' }),
        ]),
        el('div', { class: 'vstat' }, [
          el('span', { class: 'vstat__num', text: money(s.spent) }),
          el('span', { class: 'vstat__lbl', text: 'spent' }),
        ]),
      ]),

      el(
        'ul',
        { class: 'roster' },
        rosterRows(team.id).map(({ slot, pick }) =>
          el('li', { class: `roster__row${pick ? '' : ' is-empty'}` }, [
            el('span', { class: 'roster__slot', text: slot.label }),
            pick
              ? el('span', { class: 'roster__player' }, [
                  el('span', { class: `pick__pos pos-${pick.position}`, text: pick.position || '' }),
                  el('span', { text: pick.playerName }),
                ])
              : el('span', { class: 'roster__player roster__player--empty', text: 'open' }),
            el('span', { class: 'roster__price', text: pick ? money(pick.price) : '' }),
          ])
        )
      ),
    ]);
  }

  function nominatingLine() {
    const id = store.currentNominator();
    if (!id) return null;
    const team = store.teamById(id);
    if (!team) return null;
    return el('div', { class: 'vnominating' }, [
      el('span', { class: 'vnominating__lbl', text: 'nominating' }),
      el('span', { class: 'vnominating__team', text: team.name }),
    ]);
  }

  function recentList() {
    const picks = store.get().picks.slice(-RECENT_COUNT).reverse();
    if (!picks.length) return el('p', { class: 'muted', text: 'No picks yet.' });
    return el(
      'ul',
      { class: 'vrecent' },
      picks.map((pick) => {
        const team = store.teamById(pick.teamId);
        return el('li', { class: 'vrecent__row' }, [
          el('span', { class: `pick__pos pos-${pick.position}`, text: pick.position || '' }),
          el('span', { class: 'vrecent__player', text: pick.playerName }),
          el('span', { class: 'vrecent__team', text: team ? team.name : '' }),
          el('span', { class: 'vrecent__price', text: money(pick.price) }),
        ]);
      })
    );
  }

  function leagueTable(myTeamId) {
    const rows = store.get().teams.map((team) => {
      const s = store.teamSummary(team.id);
      return el('tr', { class: team.id === myTeamId ? 'is-mine' : '' }, [
        el('td', { class: 'lt__name', text: team.name }),
        el('td', { text: money(s.remaining) }),
        el('td', { text: s.open ? money(s.maxBid) : '—' }),
        el('td', { text: `${s.filled}/${s.filled + s.open}` }),
      ]);
    });
    return el('table', { class: 'lt' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Team' }),
          el('th', { text: 'Left' }),
          el('th', { text: 'Max' }),
          el('th', { text: 'Spots' }),
        ]),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  App.views = App.views || {};
  App.views.viewerBoard = {
    /** The one-time "which of these is you" screen. */
    renderTeamPicker(container, { onPick }) {
      clear(container);
      const state = store.get();
      container.append(
        el('div', { class: 'vpick' }, [
          el('h1', { text: state.name || 'Draft' }),
          el('p', { class: 'muted', text: 'Which team is yours?' }),
          el(
            'div',
            { class: 'vpick__grid' },
            state.teams.map((team) =>
              el('button', {
                class: 'btn btn--lg vpick__team',
                text: team.name,
                onclick: () => onPick(team.id),
              })
            )
          ),
          el('p', {
            class: 'muted small',
            text: 'You can change this later. This screen only ever reads the draft — nothing you do here can change it.',
          }),
        ])
      );
    },

    render(container, { teamId, freshness, phase, onChangeTeam }) {
      clear(container);
      const level = freshness.level;
      const stale = level === 'stale' || level === 'dead' || level === 'unknown';

      container.append(
        el('div', { class: `vfresh vfresh--${level}` }, [
          el('span', {
            class: 'vfresh__dot',
            title: phase === 'error' ? 'Trying to reconnect' : '',
          }),
          el('span', {
            class: 'vfresh__text',
            text:
              level === 'unknown'
                ? 'Connecting…'
                : stale
                  ? `Not updating — last change ${ago(freshness.ageMs)}`
                  : `Updated ${ago(freshness.ageMs)}`,
          }),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            text: 'Change team',
            onclick: onChangeTeam,
          }),
        ]),

        stale && level !== 'unknown'
          ? el('div', { class: 'banner banner--warn', text:
              'This screen has stopped keeping up with the draft. The numbers below may be out of date.' })
          : null,

        myTeamCard(teamId),
        nominatingLine(),
        el('section', { class: 'vcard' }, [el('h2', { text: 'Latest picks' }), recentList()]),
        el('section', { class: 'vcard' }, [el('h2', { text: 'Everyone' }), leagueTable(teamId)]),
        el('p', {
          class: 'muted small vfoot',
          text: 'Read-only. The draft itself is run from the big screen — this page follows a few seconds behind.',
        })
      );
    },
  };
})(window.DraftApp);
