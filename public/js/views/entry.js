(function (App) {
  'use strict';

  const { el, clear, money, debounce } = App.utils;
  const { store, players, validation } = App;

  // The operator types here dozens of times in a row under social pressure, so
  // the whole flow is keyboard-driven: type a name, arrow to the player, Enter,
  // type a price, Enter. Nothing waits on the network.

  let selectedPlayer = null;
  let highlighted = -1;
  let results = [];
  let pendingSlot = null;

  let nameInput, priceInput, teamSelect, resultsBox, feedback, slotBox, submitBtn;

  function positionOf() {
    return selectedPlayer ? selectedPlayer.p : '';
  }

  function currentDraft() {
    return {
      teamId: teamSelect.value,
      playerId: selectedPlayer ? selectedPlayer.id : '',
      playerName: selectedPlayer ? selectedPlayer.n : nameInput.value.trim(),
      position: positionOf(),
      price: priceInput.value === '' ? NaN : Number(priceInput.value),
      slot: pendingSlot,
    };
  }

  function renderResults() {
    clear(resultsBox);
    if (!results.length) {
      resultsBox.hidden = true;
      return;
    }
    resultsBox.hidden = false;
    results.forEach((player, i) => {
      resultsBox.append(
        el(
          'div',
          {
            class: `ac__item${i === highlighted ? ' is-active' : ''}${player.drafted ? ' is-drafted' : ''}`,
            role: 'option',
            'aria-selected': i === highlighted,
            onmousedown: (e) => {
              e.preventDefault();
              choose(i);
            },
          },
          [
            el('span', { class: 'ac__name', text: player.n }),
            el('span', { class: 'ac__meta', text: `${player.p}${player.t ? ` · ${player.t}` : ''}` }),
            player.drafted ? el('span', { class: 'ac__taken', text: 'drafted' }) : null,
          ]
        )
      );
    });
  }

  const runSearch = debounce(() => {
    const term = nameInput.value;
    results = players.isLoaded() ? players.search(term, { excludeIds: store.draftedPlayerIds() }) : [];
    highlighted = results.length ? 0 : -1;
    renderResults();
  }, 60);

  function choose(index) {
    const player = results[index];
    if (!player) return;
    selectedPlayer = player;
    nameInput.value = player.n;
    results = [];
    highlighted = -1;
    renderResults();
    pendingSlot = null;
    revalidate();
    priceInput.focus();
    priceInput.select();
  }

  function renderSlotChoice(options) {
    clear(slotBox);
    // Only ask when the choice is genuinely ambiguous; one option auto-assigns.
    if (!options || options.length <= 1) {
      slotBox.hidden = true;
      pendingSlot = options && options.length ? options[0].code : null;
      return;
    }
    slotBox.hidden = false;
    if (!options.some((o) => o.code === pendingSlot)) pendingSlot = options[0].code;
    slotBox.append(el('span', { class: 'slot-choice__label', text: 'Slot' }));
    for (const option of options) {
      slotBox.append(
        el('button', {
          type: 'button',
          class: `chip${option.code === pendingSlot ? ' is-active' : ''}`,
          text: option.label,
          onclick: () => {
            pendingSlot = option.code;
            revalidate();
          },
        })
      );
    }
  }

  function revalidate() {
    const draft = currentDraft();
    const result = validation.check(draft);
    renderSlotChoice(result.slotOptions);

    clear(feedback);
    for (const blocker of result.blockers) {
      if (blocker.code === 'no_team' || blocker.code === 'no_player' || blocker.code === 'bad_price') continue;
      feedback.append(
        el('p', {
          class: `feedback feedback--${blocker.overridable ? 'warn' : 'error'}`,
          text: blocker.message,
        })
      );
    }
    for (const warning of result.warnings) {
      feedback.append(el('p', { class: 'feedback feedback--warn', text: warning.message }));
    }

    const hard = result.blockers.some((b) => !b.overridable);
    submitBtn.disabled = hard;
    submitBtn.textContent = result.canOverride ? 'Add anyway' : 'Add pick';
    submitBtn.classList.toggle('btn--warn', result.canOverride);

    // Flag teams that can't legally win the current bid, so the operator sees
    // it in the list rather than after choosing.
    const price = currentDraft().price;
    for (const info of App.validation.eligibleTeams(price)) {
      const option = teamSelect.querySelector(`option[value="${info.id}"]`);
      if (!option) continue;
      option.textContent = info.eligible ? info.name : `${info.name} — ${info.reason}`;
      option.disabled = info.summary.open === 0;
    }

    // Live max-bid hint for the selected team.
    const team = teamSelect.value ? store.teamSummary(teamSelect.value) : null;
    const hint = document.getElementById('entry-hint');
    if (hint) {
      hint.textContent = team
        ? `${money(team.remaining)} left · ${team.open} spot${team.open === 1 ? '' : 's'} · max bid ${money(team.maxBid)}`
        : '';
    }
    return result;
  }

  function reset() {
    selectedPlayer = null;
    pendingSlot = null;
    results = [];
    highlighted = -1;
    nameInput.value = '';
    priceInput.value = '';
    renderResults();
    clear(slotBox);
    slotBox.hidden = true;
    clear(feedback);
    nameInput.focus();
  }

  function submit() {
    const draft = currentDraft();
    const result = validation.check(draft);
    if (result.blockers.some((b) => !b.overridable)) return;

    if (result.blockers.length) {
      const lines = result.blockers.map((b) => `• ${b.message}`).join('\n');
      if (!window.confirm(`${lines}\n\nAdd this pick anyway?`)) return;
    }

    store.addPick({
      ...draft,
      slot: pendingSlot || (result.slotOptions[0] && result.slotOptions[0].code) || '',
      overrides: validation.overrideFlags(result.blockers),
    });
    reset();
    revalidate();
  }

  App.views = App.views || {};
  App.views.entry = {
    render(container) {
      clear(container);

      nameInput = el('input', {
        type: 'text',
        id: 'entry-player',
        class: 'entry__player',
        placeholder: players.isLoaded() ? 'Player name…' : 'Player name (type it out)',
        autocomplete: 'off',
        'aria-autocomplete': 'list',
        oninput: () => {
          selectedPlayer = null;
          runSearch();
          revalidate();
        },
        onkeydown: (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlighted = Math.min(highlighted + 1, results.length - 1);
            renderResults();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlighted = Math.max(highlighted - 1, 0);
            renderResults();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlighted >= 0 && results.length) choose(highlighted);
            else priceInput.focus();
          } else if (e.key === 'Escape') {
            results = [];
            renderResults();
          }
        },
        onblur: () => {
          setTimeout(() => {
            results = [];
            renderResults();
          }, 120);
        },
      });

      resultsBox = el('div', { class: 'ac', role: 'listbox', hidden: true });

      teamSelect = el(
        'select',
        {
          id: 'entry-team',
          class: 'entry__team',
          onchange: () => {
            pendingSlot = null;
            revalidate();
          },
        },
        store.get().teams.map((t) => el('option', { value: t.id, text: t.name }))
      );

      priceInput = el('input', {
        type: 'number',
        id: 'entry-price',
        class: 'entry__price',
        min: '0',
        step: '1',
        placeholder: '$',
        oninput: revalidate,
        onkeydown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        },
      });

      slotBox = el('div', { class: 'slot-choice', hidden: true });
      feedback = el('div', { class: 'entry__feedback' });
      submitBtn = el('button', { type: 'button', class: 'btn btn--primary', text: 'Add pick', onclick: submit });

      container.append(
        el('div', { class: 'entry' }, [
          el('div', { class: 'entry__row' }, [
            el('div', { class: 'entry__field entry__field--grow' }, [
              el('label', { for: 'entry-player', class: 'entry__label', text: 'Player' }),
              nameInput,
              resultsBox,
            ]),
            el('div', { class: 'entry__field' }, [
              el('label', { for: 'entry-team', class: 'entry__label', text: 'Won by' }),
              teamSelect,
            ]),
            el('div', { class: 'entry__field entry__field--price' }, [
              el('label', { for: 'entry-price', class: 'entry__label', text: 'Price' }),
              priceInput,
            ]),
            submitBtn,
          ]),
          el('div', { class: 'entry__row entry__row--sub' }, [
            el('span', { id: 'entry-hint', class: 'muted small' }),
            slotBox,
          ]),
          feedback,
        ])
      );

      revalidate();
      nameInput.focus();
    },

    focus() {
      if (nameInput) nameInput.focus();
    },

    refresh() {
      if (!teamSelect) return;
      // Team list can change if the operator edits setup mid-draft.
      const current = teamSelect.value;
      clear(teamSelect);
      for (const t of store.get().teams) {
        teamSelect.append(el('option', { value: t.id, text: t.name }));
      }
      if (store.teamById(current)) teamSelect.value = current;
      revalidate();
    },

    /** Recompute the budget hint after any state change (undo, edit, delete). */
    revalidate() {
      if (teamSelect) revalidate();
    },
  };
})(window.DraftApp);
