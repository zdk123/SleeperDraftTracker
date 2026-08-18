(function (App) {
  'use strict';

  const { el, clear, money } = App.utils;
  const { store } = App;

  // Full pick log with edit/delete. Mistakes happen live, and because sync is a
  // full snapshot, an edit here needs no special handling to reach the sheet.

  let editingId = null;
  let mount = null;

  function rerender() {
    if (mount) App.views.history.render(mount);
  }

  function editRow(pick) {
    const nameInput = el('input', { type: 'text', value: pick.playerName, class: 'mini' });
    const teamSelect = el(
      'select',
      { class: 'mini' },
      store.get().teams.map((t) =>
        el('option', { value: t.id, text: t.name, ...(t.id === pick.teamId ? { selected: true } : {}) })
      )
    );
    const priceInput = el('input', { type: 'number', min: '0', value: String(pick.price), class: 'mini' });

    // An edit goes through the same guardrails as a new pick. Without this it
    // was possible to edit a pick into a duplicate player, a full roster, or a
    // price above the team's legal max -- producing a draft that could not be
    // entered into Sleeper afterward, which is the one thing these rules exist
    // to guarantee.
    const save = () => {
      const changes = {
        playerName: nameInput.value.trim() || pick.playerName,
        teamId: teamSelect.value,
        price: Number(priceInput.value) || 0,
      };
      const result = App.validation.check({
        ...changes,
        playerId: pick.playerId,
        position: pick.position,
        slot: pick.slot,
        ignorePickId: pick.id,
      });

      const hard = result.blockers.filter((b) => !b.overridable);
      if (hard.length) {
        window.alert(`${hard.map((b) => `• ${b.message}`).join('\n')}\n\nThe edit was not saved.`);
        return;
      }
      if (result.blockers.length) {
        const lines = result.blockers.map((b) => `• ${b.message}`).join('\n');
        if (!window.confirm(`${lines}\n\nSave this edit anyway?`)) return;
      }

      store.updatePick(pick.id, changes);
      editingId = null;
      rerender();
    };

    priceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });

    return el('div', { class: 'hist__row hist__row--edit' }, [
      nameInput,
      teamSelect,
      priceInput,
      el('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Save', onclick: save }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'Cancel',
        onclick: () => {
          editingId = null;
          rerender();
        },
      }),
    ]);
  }

  function readRow(pick, number) {
    const team = store.teamById(pick.teamId);
    return el('div', { class: 'hist__row' }, [
      el('span', { class: 'hist__num', text: `#${number}` }),
      el('span', { class: 'hist__player', text: pick.playerName }),
      el('span', {
        class: 'hist__pos',
        text: `${pick.position}${pick.nflTeam ? ` · ${pick.nflTeam}` : ''}`,
      }),
      el('span', { class: 'hist__team', text: team ? team.name : '—' }),
      el('span', { class: 'hist__slot', text: pick.slot }),
      el('span', { class: 'hist__price', text: money(pick.price) }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'Edit',
        onclick: () => {
          editingId = pick.id;
          rerender();
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'Delete',
        onclick: () => {
          if (window.confirm(`Delete ${pick.playerName} (${money(pick.price)})?`)) {
            store.removePick(pick.id);
            rerender();
          }
        },
      }),
    ]);
  }

  App.views = App.views || {};
  App.views.history = {
    render(container) {
      mount = container;
      clear(container);

      const picks = store.get().picks;
      if (!picks.length) {
        container.append(el('p', { class: 'muted', text: 'No picks yet.' }));
        return;
      }

      const list = el('div', { class: 'hist' });
      // Newest first: that's the one most likely to need fixing.
      picks
        .slice()
        .reverse()
        .forEach((pick, i) => {
          const number = picks.length - i;
          list.append(pick.id === editingId ? editRow(pick) : readRow(pick, number));
        });

      container.append(list);
    },
  };
})(window.DraftApp);
