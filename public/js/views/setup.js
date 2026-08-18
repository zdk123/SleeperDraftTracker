(function (App) {
  'use strict';

  const { el, clear, uid } = App.utils;
  const { store } = App;

  // Everything is editable and nothing here requires a network call. Sleeper
  // prefill and the connection test are conveniences that degrade to a message.

  let teams = [];
  let slots = [];
  let root = null;

  function defaultTeams(count) {
    return Array.from({ length: count }, (_, i) => ({
      id: uid('team'),
      name: `Team ${i + 1}`,
      manager: '',
      sleeperUserId: '',
    }));
  }

  function note(el_, message, kind) {
    clear(el_);
    if (!message) return;
    el_.append(el('span', { class: `note note--${kind || 'info'}`, text: message }));
  }

  function renderTeamRows(container) {
    clear(container);
    teams.forEach((team, index) => {
      container.append(
        el('div', { class: 'team-row' }, [
          el('span', { class: 'team-row__num', text: String(index + 1) }),
          el('input', {
            type: 'text',
            value: team.name,
            'aria-label': `Team ${index + 1} name`,
            placeholder: 'Team name',
            oninput: (e) => {
              team.name = e.target.value;
              App.bus.emit('setup:teams-changed');
            },
          }),
          el('input', {
            type: 'text',
            value: team.manager,
            'aria-label': `Team ${index + 1} manager`,
            placeholder: 'Manager (optional)',
            oninput: (e) => {
              team.manager = e.target.value;
            },
          }),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--icon',
            title: 'Remove team',
            text: '×',
            onclick: () => {
              teams.splice(index, 1);
              renderTeamRows(container);
              App.bus.emit('setup:teams-changed');
            },
          }),
        ])
      );
    });
  }

  function renderSlotRows(container) {
    clear(container);
    slots.forEach((slot) => {
      container.append(
        el('div', { class: 'slot-row' }, [
          el('label', { class: 'slot-row__label', text: slot.label }),
          el('input', {
            type: 'number',
            min: '0',
            max: '20',
            value: String(slot.count),
            'aria-label': `${slot.label} count`,
            oninput: (e) => {
              slot.count = Math.max(0, Number(e.target.value) || 0);
              App.bus.emit('setup:slots-changed');
            },
          }),
          el('span', {
            class: 'slot-row__pos',
            text: slot.eligiblePositions.join(' / '),
          }),
        ])
      );
    });
  }

  App.views = App.views || {};
  App.views.setup = {
    render(container, { onStart }) {
      root = container;
      clear(container);

      if (!teams.length) teams = defaultTeams(12);
      if (!slots.length) {
        slots = store.DEFAULT_ROSTER_SLOTS.map((s) => ({ ...s, eligiblePositions: [...s.eligiblePositions] }));
      }

      const teamRows = el('div', { class: 'team-rows' });
      const slotRows = el('div', { class: 'slot-rows' });
      const sleeperNote = el('div', { class: 'note-slot' });
      const healthNote = el('div', { class: 'note-slot' });
      const totalSlots = el('span', { class: 'pill' });

      const nameInput = el('input', {
        type: 'text',
        id: 'draft-name',
        placeholder: 'e.g. Kurtz League 2026',
        maxlength: '40',
      });
      const budgetInput = el('input', {
        type: 'number',
        min: '1',
        value: '200',
        id: 'budget',
      });
      // Sleeper's floor is $1. Zero would let $0 picks through validation and
      // produce a draft that cannot be entered into Sleeper afterward.
      const reserveInput = el('input', {
        type: 'number',
        min: '1',
        value: '1',
        id: 'reserve',
      });
      const styleSelect = el('select', { id: 'nom-style' }, [
        el('option', { value: 'rotating', text: 'Rotating — same order every round' }),
        el('option', { value: 'snake', text: 'Snake — order reverses each round' }),
      ]);
      const orderList = el('ol', { class: 'order-list' });

      function renderOrder() {
        clear(orderList);
        teams.forEach((team, i) => {
          orderList.append(
            el('li', { class: 'order-list__item' }, [
              el('span', { class: 'order-list__pos', text: String(i + 1) }),
              el('span', { class: 'order-list__name', text: team.name || `Team ${i + 1}` }),
              el('span', { class: 'order-list__moves' }, [
                el('button', {
                  type: 'button',
                  class: 'btn btn--ghost btn--icon',
                  title: 'Move up',
                  text: '↑',
                  disabled: i === 0,
                  onclick: () => {
                    [teams[i - 1], teams[i]] = [teams[i], teams[i - 1]];
                    renderOrder();
                    renderTeamRows(teamRows);
                  },
                }),
                el('button', {
                  type: 'button',
                  class: 'btn btn--ghost btn--icon',
                  title: 'Move down',
                  text: '↓',
                  disabled: i === teams.length - 1,
                  onclick: () => {
                    [teams[i + 1], teams[i]] = [teams[i], teams[i + 1]];
                    renderOrder();
                    renderTeamRows(teamRows);
                  },
                }),
              ]),
            ])
          );
        });
      }
      const tokenInput = el('input', {
        type: 'password',
        id: 'token',
        placeholder: 'Leave blank if not using Sheets',
        value: App.persistence.prefs().token || '',
      });

      const scriptUrlInput = el('input', {
        type: 'url',
        id: 'apps-script-url',
        placeholder: 'https://script.google.com/macros/s/…/exec',
        value: App.persistence.prefs().appsScriptUrl || '',
      });
      const scriptUrlField = el('div', { class: 'field' }, [
        el('label', { for: 'apps-script-url', text: 'Web app URL' }),
        scriptUrlInput,
        el('p', {
          class: 'muted small',
          text: 'Apps Script → Deploy → Manage deployments. It must end in /exec, not /dev.',
        }),
      ]);

      const viewTokenInput = el('input', {
        type: 'text',
        id: 'view-token',
        placeholder: 'Leave blank to keep the draft private',
        value: App.persistence.prefs().viewToken || '',
      });

      function applySheetSettings() {
        App.sync.configure({
          appsScriptUrl: scriptUrlInput.value.trim(),
          token: tokenInput.value.trim(),
        });
        App.persistence.setPref('viewToken', viewTokenInput.value.trim());
      }
      scriptUrlInput.addEventListener('change', applySheetSettings);
      tokenInput.addEventListener('change', applySheetSettings);
      viewTokenInput.addEventListener('change', applySheetSettings);
      applySheetSettings();
      const usernameInput = el('input', { type: 'text', id: 'sleeper-user', placeholder: 'Sleeper username' });
      const leagueInput = el('input', { type: 'text', id: 'sleeper-league', placeholder: 'or paste a league ID' });

      function updateTotal() {
        const n = slots.reduce((sum, s) => sum + s.count, 0);
        clear(totalSlots).append(document.createTextNode(`${n} roster spots per team`));
      }
      App.bus.on('setup:slots-changed', updateTotal);

      App.bus.on('setup:teams-changed', renderOrder);

      renderTeamRows(teamRows);
      renderSlotRows(slotRows);
      renderOrder();
      updateTotal();

      container.append(
        el('div', { class: 'setup' }, [
          el('header', { class: 'setup__head' }, [
            el('h1', { text: 'New auction draft' }),
            el('p', {
              class: 'muted',
              text: 'Set this up before draft night. Everything can be changed later.',
            }),
            el('div', { class: 'field field--name' }, [
              el('label', { for: 'draft-name', text: 'Draft name (optional)' }),
              nameInput,
              el('p', {
                class: 'muted small',
                text:
                  'Names the export files and the spreadsheet tabs, so a practice run and the ' +
                  'real thing stay apart.',
              }),
            ]),
          ]),

          // --- teams
          el('section', { class: 'card' }, [
            el('div', { class: 'card__head' }, [
              el('h2', { text: 'Teams' }),
              el('div', { class: 'row-actions' }, [
                el('button', {
                  type: 'button',
                  class: 'btn btn--ghost',
                  text: '+ Add team',
                  onclick: () => {
                    teams.push({ id: uid('team'), name: `Team ${teams.length + 1}`, manager: '', sleeperUserId: '' });
                    renderTeamRows(teamRows);
                    App.bus.emit('setup:teams-changed');
                  },
                }),
              ]),
            ]),
            teamRows,
            el('details', { class: 'prefill' }, [
              el('summary', { text: 'Import names from Sleeper (optional)' }),
              el('p', {
                class: 'muted small',
                text: 'Needs internet. Only fills in the names above — you can still edit them.',
              }),
              el('div', { class: 'field-row' }, [
                usernameInput,
                el('button', {
                  type: 'button',
                  class: 'btn btn--ghost',
                  text: 'Find leagues',
                  onclick: async (e) => {
                    const name = usernameInput.value.trim();
                    if (!name) return;
                    e.target.disabled = true;
                    note(sleeperNote, 'Looking up…');
                    try {
                      const result = await App.sleeper.leaguesForUser(name);
                      if (!result.ok) {
                        note(sleeperNote, result.message, 'warn');
                      } else if (result.leagues.length === 1) {
                        leagueInput.value = result.leagues[0].id;
                        note(sleeperNote, `Found "${result.leagues[0].name}". Now click Load teams.`, 'ok');
                      } else {
                        note(
                          sleeperNote,
                          `Found ${result.leagues.length} leagues: ` +
                            result.leagues.map((l) => `${l.name} (${l.id})`).join(', ') +
                            ' — paste the right ID below.',
                          'ok'
                        );
                      }
                    } catch (err) {
                      note(sleeperNote, `Could not reach Sleeper: ${err.message}`, 'warn');
                    } finally {
                      e.target.disabled = false;
                    }
                  },
                }),
              ]),
              el('div', { class: 'field-row' }, [
                leagueInput,
                el('button', {
                  type: 'button',
                  class: 'btn btn--ghost',
                  text: 'Load teams',
                  onclick: async (e) => {
                    const id = leagueInput.value.trim();
                    if (!id) return;
                    e.target.disabled = true;
                    note(sleeperNote, 'Loading teams…');
                    try {
                      const result = await App.sleeper.teamsForLeague(id);
                      if (!result.ok) {
                        note(sleeperNote, result.message, 'warn');
                      } else {
                        teams = result.teams.map((t) => ({ ...t, id: uid('team') }));
                        renderTeamRows(teamRows);
                        App.bus.emit('setup:teams-changed');
                        note(sleeperNote, `Loaded ${teams.length} teams.`, 'ok');
                      }
                    } catch (err) {
                      note(sleeperNote, `Could not reach Sleeper: ${err.message}`, 'warn');
                    } finally {
                      e.target.disabled = false;
                    }
                  },
                }),
              ]),
              sleeperNote,
            ]),
          ]),

          // --- money + roster
          el('div', { class: 'setup__grid' }, [
            el('section', { class: 'card' }, [
              el('h2', { text: 'Money' }),
              el('div', { class: 'field' }, [
                el('label', { for: 'budget', text: 'Budget per team' }),
                budgetInput,
              ]),
              el('div', { class: 'field' }, [
                el('label', { for: 'reserve', text: 'Minimum bid' }),
                reserveInput,
                el('p', {
                  class: 'muted small',
                  text:
                    'Sleeper’s rule: a team must always keep this much for every roster spot ' +
                    'they still have to fill, so the app caps their bids accordingly.',
                }),
              ]),
            ]),

            el('section', { class: 'card' }, [
              el('div', { class: 'card__head' }, [el('h2', { text: 'Roster spots' }), totalSlots]),
              slotRows,
            ]),
          ]),

          el('section', { class: 'card' }, [
            el('div', { class: 'card__head' }, [
              el('h2', { text: 'Nomination order' }),
              el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: '🎲 Shuffle',
                onclick: () => {
                  teams = store.shuffled(teams);
                  renderOrder();
                  renderTeamRows(teamRows);
                },
              }),
            ]),
            el('p', {
              class: 'muted small',
              text:
                'Who opens the bidding on each player. Draw it at random, then it stays fixed ' +
                'for the whole draft. Teams that are full get skipped automatically.',
            }),
            el('div', { class: 'field' }, [
              el('label', { for: 'nom-style', text: 'Order style' }),
              styleSelect,
            ]),
            orderList,
          ]),

          // --- sheets
          el('section', { class: 'card' }, [
            el('h2', { text: 'Google Sheet backup' }),
            el('p', {
              class: 'muted small',
              text:
                'Optional. With it, every pick is copied to a spreadsheet as you go — ' +
                'automatically, no button to press. Without it, the draft still works and ' +
                'saves in this browser.',
            }),
            scriptUrlField,
            el('div', { class: 'field' }, [
              el('label', { for: 'token', text: 'Access token' }),
              tokenInput,
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'view-token', text: 'Viewer link token' }),
              viewTokenInput,
              el('p', {
                class: 'muted small',
                text:
                  'Optional, and must be DIFFERENT from the access token above. It lets you share ' +
                  'a link so people can follow their own roster on their phones — read-only, they ' +
                  'cannot change the draft. Paste the same value into VIEW_TOKEN in Code.gs, then ' +
                  're-publish: Deploy → Manage deployments → ✏️ → Version: New version → Deploy. ' +
                  '(“New deployment” would give you a different URL and break this setup.)',
              }),
            ]),
            el('div', { class: 'field-row' }, [
              el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: 'Test connection',
                onclick: async (e) => {
                  e.target.disabled = true;
                  note(healthNote, 'Testing…');
                  applySheetSettings();
                  try {
                    const health = await App.sync.health();
                    const kind = health.ok ? 'ok' : health.hasCredentials ? 'warn' : 'info';
                    note(
                      healthNote,
                      `${health.message}${health.hint ? ` ${health.hint}` : ''}` +
                        (health.ok ? ` (${health.latencyMs}ms)` : ''),
                      kind
                    );
                  } catch (err) {
                    // The hint is the part that says what to actually do about
                    // it, so never drop it on the floor.
                    note(healthNote, `${err.message}${err.hint ? ` ${err.hint}` : ''}`, 'warn');
                  } finally {
                    e.target.disabled = false;
                  }
                },
              }),
            ]),
            healthNote,
          ]),

          el('div', { class: 'setup__actions' }, [
            el('button', {
              type: 'button',
              class: 'btn btn--primary btn--lg',
              text: 'Start draft',
              onclick: () => {
                const named = teams.filter((t) => t.name.trim());
                if (named.length < 2) {
                  window.alert('Add at least two teams.');
                  return;
                }
                if (!slots.some((s) => s.count > 0)) {
                  window.alert('Give each team at least one roster spot.');
                  return;
                }
                const tokenValue = tokenInput.value.trim();
                const viewTokenValue = viewTokenInput.value.trim();
                // Pasting the write token into the viewer box would hand every
                // guest the ability to overwrite the draft -- the exact thing
                // the second token exists to prevent.
                if (viewTokenValue && viewTokenValue === tokenValue) {
                  window.alert(
                    'The viewer link token must be different from the access token. ' +
                      'Anyone you share the link with would otherwise be able to change the draft.'
                  );
                  return;
                }
                App.persistence.setPref('token', tokenValue);
                App.persistence.setPref('viewToken', viewTokenValue);
                App.persistence.setPref('appsScriptUrl', scriptUrlInput.value.trim());
                App.sync.configure({
                  token: tokenValue,
                  appsScriptUrl: scriptUrlInput.value.trim(),
                });
                store.create({
                  teams: named,
                  name: nameInput.value,
                  settings: {
                    budgetPerTeam: Number(budgetInput.value) || 200,
                    minBid: Math.max(1, Number(reserveInput.value) || 1),
                    rosterSlots: slots.filter((s) => s.count > 0),
                    nominationStyle: styleSelect.value,
                    sleeperLeagueId: leagueInput.value.trim() || null,
                  },
                });
                onStart();
              },
            }),
          ]),
        ])
      );
    },
  };
})(window.DraftApp);
