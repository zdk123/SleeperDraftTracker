(function (App) {
  'use strict';

  const { el, clear } = App.utils;
  const { store, persistence, sync } = App;

  App.VERSION = '1.0.0';

  let screens = {};
  let readOnly = false;

  // --- theme -----------------------------------------------------------------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    persistence.setPref('theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☾' : '☀';
      btn.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
    }
  }

  function initTheme() {
    const saved = persistence.prefs().theme;
    const preferred =
      saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(preferred);
  }

  // --- rendering -------------------------------------------------------------

  function show(name) {
    for (const [key, node] of Object.entries(screens)) {
      node.hidden = key !== name;
    }
    document.body.dataset.screen = name;
  }

  function renderDraft() {
    App.views.board.render(screens.board.querySelector('.screen__body'));
    // The entry hint shows the selected team's remaining budget and max bid, so
    // it has to follow undo/edit/delete too -- not just picks added through it.
    App.views.entry.revalidate();
    if (document.body.dataset.panel === 'history') {
      App.views.history.render(document.getElementById('panel-body'));
    }
  }

  function openPanel(kind) {
    const panel = document.getElementById('panel');
    const body = document.getElementById('panel-body');
    const title = document.getElementById('panel-title');
    document.body.dataset.panel = kind;
    panel.hidden = false;

    if (kind === 'history') {
      title.textContent = 'All picks';
      App.views.history.render(body);
    } else if (kind === 'share') {
      title.textContent = 'Share with the room';
      renderSharePanel(body);
    } else if (kind === 'export') {
      title.textContent = 'Save & export';
      renderExportPanel(body);
    } else if (kind === 'recover') {
      title.textContent = 'Backup & recovery';
      renderRecoverPanel(body);
    }
  }

  function closePanel() {
    document.getElementById('panel').hidden = true;
    document.body.dataset.panel = '';
  }

  function renderExportPanel(body) {
    clear(body);
    body.append(
      el('p', {
        class: 'muted',
        text: 'Use the roster list when typing results into Sleeper afterward.',
      }),
      el('div', { class: 'btn-stack' }, [
        el('button', {
          class: 'btn btn--primary',
          text: 'Rosters (text)',
          onclick: () => App.exporter.downloadRostersText(),
        }),
        el('button', {
          class: 'btn',
          text: 'Rosters (CSV)',
          onclick: () => App.exporter.downloadRostersCsv(),
        }),
        el('button', {
          class: 'btn',
          text: 'Pick log (CSV)',
          onclick: () => App.exporter.downloadPicksCsv(),
        }),
        el('button', {
          class: 'btn',
          text: 'Full backup (JSON)',
          onclick: () => App.exporter.downloadStateJson(),
        }),
      ]),
      el('h3', { text: 'Copy & paste' }),
      el('textarea', { class: 'copybox', readonly: true, rows: '18', text: App.exporter.rostersText() })
    );
  }

  /**
   * The viewer link. Everything a guest's phone needs travels in the URL,
   * because there is no server to hold it -- so this panel is the only place
   * that link can come from.
   */
  function renderSharePanel(body) {
    clear(body);
    const prefs = persistence.prefs();
    const scriptUrl = prefs.appsScriptUrl || '';
    const viewToken = prefs.viewToken || '';
    const state = store.get();

    const explain = (text) => el('p', { class: 'muted', text });

    // One place decides whether a link from here would work in someone else's
    // hands; the board's QR asks the same question the same way.
    const { ok, reason } = App.shareLink.availability({
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      scriptUrl,
      viewToken,
      writeToken: prefs.token || '',
    });

    if (!ok) {
      const problems = {
        file: [
          'Not from this address',
          'You opened the draft board as a file on this computer, which has no web address ' +
            'other people can reach. Viewer links need the hosted version.',
        ],
        local: [
          'Not from this address',
          'You are running the draft board on this laptop only, so a link to it would just ' +
            'point at each guest’s own phone. Viewer links need the hosted version.',
        ],
        'no-sheet': [
          'Not set up yet',
          'Sharing reads the draft out of your Google Sheet, so the sheet backup has to be ' +
            'working first. There is no spreadsheet connected to this draft.',
        ],
        'same-token': [
          'These two tokens must differ',
          'Your viewer token is the same as your access token, so the link would let anyone ' +
            'who has it change the draft. Change one of them on the setup screen first.',
        ],
      };

      if (reason === 'no-token') {
        body.append(
          el('h3', { text: 'Viewer links are off' }),
          explain(
            'To let people follow the draft on their phones, pick a second random word or phrase — ' +
              'different from your access token — and do two things with it:'
          ),
          el('ol', { class: 'steps' }, [
            el('li', { text: 'Put it in the “Viewer link token” box on the setup screen.' }),
            el('li', {
              text:
                'Put the same value into VIEW_TOKEN at the top of Code.gs, then re-publish: ' +
                'Deploy → Manage deployments → ✏️ → Version: New version → Deploy.',
            }),
          ]),
          explain(
            'That second step is the one people miss. Editing Code.gs changes nothing on its own — ' +
              'a deployment is a frozen snapshot until you publish a new version of it.'
          )
        );
        return;
      }

      const [heading, detail] = problems[reason] || ['Sharing is not available', ''];
      body.append(el('h3', { text: heading }), explain(detail));
      if (reason === 'file' || reason === 'local') {
        body.append(
          explain(
            'Your draft is completely fine here — this only affects sharing. Open the same draft ' +
              'from the hosted address to hand out links.'
          )
        );
      }
      return;
    }

    const link = App.shareLink.build({
      origin: window.location.origin + window.location.pathname.replace(/[^/]*$/, ''),
      url: scriptUrl,
      token: viewToken,
      draftKey: state.draftKey,
    });

    const box = el('textarea', { class: 'copybox', readonly: true, rows: '4', text: link });
    const status = el('div', { class: 'note-slot' });

    body.append(
      explain(
        'The code is on the draft board too — click it there to blow it up for the room. This ' +
          'opens a read-only page showing whoever scans it their own roster, budget and max bid, ' +
          'updating on its own a few seconds behind the room.'
      ),
      el('div', { class: 'share-qr' }, [App.views.qrcode.render(link)]),
      el('div', { class: 'btn-stack' }, [
        el('button', {
          class: 'btn btn--primary',
          text: 'Show it big on the screen',
          onclick: () => {
            closePanel();
            App.views.shareCode.open();
          },
        }),
      ]),
      el('h3', { text: 'Or send the link' }),
      box,
      el('div', { class: 'btn-stack' }, [
        el('button', {
          class: 'btn',
          text: 'Copy link',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(link);
              clear(status).append(el('span', { class: 'note note--ok', text: 'Copied.' }));
            } catch {
              // Clipboard access is blocked on file:// and in some browsers;
              // selecting the text is a fine fallback and needs no permission.
              box.select();
              clear(status).append(
                el('span', { class: 'note note--info', text: 'Selected — press Ctrl/Cmd+C to copy.' })
              );
            }
          },
        }),
        el('button', {
          class: 'btn',
          text: 'Open it myself',
          onclick: () => window.open(link, '_blank', 'noopener'),
        }),
      ]),
      status,
      el('hr'),
      el('h3', { text: 'What people can and cannot do' }),
      el('ul', { class: 'steps' }, [
        el('li', { text: 'See every team’s roster, spending and remaining budget. Nothing is hidden.' }),
        el('li', { text: 'They cannot enter, edit or undo a pick — the page has no way to write at all.' }),
        el('li', { text: 'Anyone the link is forwarded to can watch, so treat it as public to the party.' }),
        el('li', {
          text:
            'It only works while both you and they have internet. If the wifi drops, your draft ' +
            'keeps running here and their screens say they have stopped updating.',
        }),
      ])
    );
  }

  function renderRecoverPanel(body) {
    clear(body);
    const status = el('div', { class: 'note-slot' });

    body.append(
      el('p', {
        class: 'muted',
        text:
          'Every pick is saved on this computer the moment you enter it. The Google Sheet ' +
          'is a second copy in case something happens to this computer.',
      }),
      el('div', { class: 'btn-stack' }, [
        el('button', {
          class: 'btn',
          text: 'Save to sheet now',
          onclick: async () => {
            clear(status).append(el('span', { class: 'note', text: 'Saving…' }));
            await sync.flushNow('manual');
            const snap = sync.snapshot();
            clear(status).append(
              el('span', {
                class: `note note--${snap.status === 'synced' ? 'ok' : 'warn'}`,
                text: snap.status === 'synced' ? 'Saved to the sheet.' : snap.detail || snap.status,
              })
            );
          },
        }),
        el('button', {
          class: 'btn',
          text: 'Check the sheet’s copy',
          onclick: async () => {
            clear(status).append(el('span', { class: 'note', text: 'Checking…' }));
            const { verdict, remote } = await App.restore.compare(store.get());
            const messages = {
              match: 'The sheet matches this computer.',
              'local-ahead': 'This computer is ahead — use “Save to sheet now”.',
              'remote-ahead': `The sheet has a newer copy (${remote?.state.picks.length} picks).`,
              diverged:
                `The sheet disagrees with this screen (${remote?.state.picks.length} picks there, ` +
                `${store.get().picks.length} here). This computer's copy is the one you have been ` +
                'watching — use “Save to sheet now” unless you know otherwise.',
              'local-only': 'This draft is not in the sheet yet.',
              'remote-only': `The sheet has a draft with ${remote?.state.picks.length} picks.`,
              'no-remote': 'Could not reach the sheet. Your picks are still safe here.',
            };
            clear(status).append(el('span', { class: 'note note--info', text: messages[verdict] }));

            if ((verdict === 'remote-ahead' || verdict === 'remote-only') && remote) {
              status.append(
                el('button', {
                  class: 'btn btn--warn btn--sm',
                  text: 'Replace this computer’s copy with the sheet’s',
                  onclick: () => {
                    if (!window.confirm('This replaces the draft on screen. Continue?')) return;
                    App.restore.adoptRemote(remote);
                    closePanel();
                  },
                })
              );
            }
          },
        }),
        el('button', {
          class: 'btn',
          text: 'List drafts in the sheet',
          onclick: async () => {
            clear(status).append(el('span', { class: 'note', text: 'Loading…' }));
            let drafts;
            try {
              drafts = await App.restore.listRemote();
            } catch (err) {
              clear(status).append(
                el('span', { class: 'note note--warn', text: `Could not reach the sheet: ${err.message}` })
              );
              return;
            }
            clear(status);
            if (!drafts.length) {
              status.append(el('span', { class: 'note note--info', text: 'The sheet has no drafts yet.' }));
              return;
            }
            const current = store.exists() ? store.get().draftKey : null;
            status.append(
              el(
                'div',
                { class: 'draft-list' },
                drafts.map((d) =>
                  el('div', { class: `draft-list__row${d.draftKey === current ? ' is-current' : ''}` }, [
                    el('div', { class: 'draft-list__main' }, [
                      el('span', { class: 'draft-list__name', text: d.name || d.draftKey }),
                      el('span', {
                        class: 'draft-list__meta',
                        text: `${d.picks} picks · ${d.teams} teams · saved ${d.updated || '—'}`,
                      }),
                    ]),
                    d.draftKey === current
                      ? el('span', { class: 'pill', text: 'on screen' })
                      : el('button', {
                          class: 'btn btn--sm',
                          text: 'Load',
                          onclick: async () => {
                            if (!window.confirm(`Replace the draft on screen with "${d.name || d.draftKey}"?`)) return;
                            const remote = await App.sync.fetchRemote(d.draftKey);
                            if (!remote.found) {
                              window.alert('That draft could not be read back from the sheet.');
                              return;
                            }
                            App.restore.adoptRemote(remote);
                            closePanel();
                          },
                        }),
                  ])
                )
              )
            );
          },
        }),
        el('button', {
          class: 'btn btn--warn',
          text: 'Overwrite the sheet with this computer’s copy',
          onclick: async () => {
            if (!window.confirm('This replaces whatever is in the sheet. Continue?')) return;
            clear(status).append(el('span', { class: 'note', text: 'Overwriting…' }));
            await sync.forceOverwrite();
            clear(status).append(el('span', { class: 'note note--ok', text: 'Done.' }));
          },
        }),
      ]),
      status,
      el('hr'),
      el('div', { class: 'btn-stack' }, [
        el('button', {
          class: 'btn btn--ghost',
          text: 'Start a completely new draft',
          onclick: () => {
            if (!window.confirm('This clears the draft on screen. Export a backup first if you need one.')) return;
            persistence.clear();
            window.location.reload();
          },
        }),
      ])
    );
  }

  // --- chrome ----------------------------------------------------------------

  function buildChrome() {
    const bar = document.getElementById('topbar-actions');
    App.views.syncStatus.mount(bar);

    bar.append(
      el('button', {
        class: 'btn btn--ghost btn--sm',
        text: 'Undo',
        title: 'Undo the last pick',
        onclick: () => {
          const state = store.get();
          if (!state.picks.length) return;
          const last = state.picks[state.picks.length - 1];
          if (window.confirm(`Undo ${last.playerName} (${App.utils.money(last.price)})?`)) {
            store.undoLast();
          }
        },
      }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        text: 'Picks',
        onclick: () => openPanel('history'),
      }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        text: 'Share',
        title: 'Let people follow the draft on their phones',
        onclick: () => openPanel('share'),
      }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        text: 'Export',
        onclick: () => openPanel('export'),
      }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        text: 'Backup',
        onclick: () => openPanel('recover'),
      }),
      el('button', {
        id: 'theme-toggle',
        class: 'btn btn--ghost btn--icon',
        onclick: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
      })
    );

    document.getElementById('panel-close').addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // The enlarged QR sits on top of everything, so it closes first.
      if (App.views.shareCode.isOpen()) return App.views.shareCode.close();
      if (!document.getElementById('panel').hidden) closePanel();
    });
  }

  function banner(message, kind, actions) {
    const host = document.getElementById('banners');
    const node = el('div', { class: `banner banner--${kind}` }, [
      el('span', { text: message }),
      ...(actions || []).map((a) =>
        el('button', {
          class: 'btn btn--sm',
          text: a.label,
          onclick: () => {
            a.run();
            node.remove();
          },
        })
      ),
      el('button', { class: 'btn btn--ghost btn--icon', text: '×', onclick: () => node.remove() }),
    ]);
    host.append(node);
    return node;
  }

  // --- boot ------------------------------------------------------------------

  function startDraftScreen() {
    show('board');
    App.views.entry.render(document.getElementById('entry-host'));
    // Mounted once. The link can't change mid-draft, and rebuilding ~1,400 SVG
    // subpaths on every pick would be work for nothing.
    App.views.shareCode.mount(document.getElementById('board-qr'));
    renderDraft();
  }

  async function boot() {
    screens = {
      setup: document.getElementById('screen-setup'),
      board: document.getElementById('screen-board'),
    };

    initTheme();
    sync.init({
      token: persistence.prefs().token || '',
      appsScriptUrl: persistence.prefs().appsScriptUrl || '',
    });

    // A second tab on a full-snapshot sync model is a genuine data-loss path.
    if (!persistence.claimSession()) {
      readOnly = true;
      store.setReadOnly(true);
      banner(
        'This draft is already open in another window. Enter picks there, or take over here.',
        'warn',
        [
          {
            label: 'Take over',
            run: () => {
              persistence.takeoverSession();
              readOnly = false;
              store.setReadOnly(false);
              window.location.reload();
            },
          },
        ]
      );
    }
    persistence.startHeartbeat();
    window.addEventListener('beforeunload', () => persistence.releaseSession());

    // One deployment writes to one spreadsheet, so the sheet can be holding a
    // draft that isn't this one. Say so plainly and let the operator choose --
    // silently overwriting would destroy the backup of a draft in progress.
    App.bus.on('sync:conflict', (info) => {
      if (document.getElementById('sync-conflict-banner')) return;
      const node = banner(
        info.differentDraft
          ? 'The spreadsheet is holding a different draft. Your picks are safe here, but they are not being backed up.'
          : 'The spreadsheet has a newer copy of this draft. Your picks are safe here, but they are not being backed up.',
        'warn',
        [
          {
            label: 'Use the sheet for this draft',
            run: () => {
              if (window.confirm('This replaces whatever the spreadsheet currently holds. Continue?')) {
                sync.forceOverwrite();
              }
            },
          },
          { label: 'Open Backup', run: () => openPanel('recover') },
        ]
      );
      node.id = 'sync-conflict-banner';
    });

    // A blocked write has to be visible. Silently dropping a pick in a mirror
    // window is exactly the failure the lock exists to prevent.
    App.bus.on('state:readonly-blocked', ({ action }) => {
      banner(
        `This window is a read-only mirror, so it can't ${action}. ` +
          'Use the window where the draft is already open, or take over here.',
        'warn',
        [
          {
            label: 'Take over',
            run: () => {
              persistence.takeoverSession();
              store.setReadOnly(false);
              window.location.reload();
            },
          },
        ]
      );
    });

    App.bus.on('storage:failed', () => {
      banner(
        'This browser stopped saving. Download a backup now and keep going.',
        'error',
        [{ label: 'Download backup', run: () => App.exporter.downloadStateJson() }]
      );
    });

    const playersResult = await App.players.load();
    if (!playersResult.ok) {
      banner('Player list unavailable — type player names in full instead.', 'warn', []);
    }

    // Persist and replicate on every mutation. Local first, always.
    store.subscribe((state, reason) => {
      if (reason === 'load' || reason === 'restore') {
        persistence.save(state);
      } else {
        persistence.save(state);
        sync.notify(reason);
      }
      if (document.body.dataset.screen === 'board') {
        renderDraft();
        if (reason === 'teams' || reason === 'settings') App.views.entry.refresh();
      }
    });

    buildChrome();

    const saved = App.restore.local();
    if (saved && saved.picks) {
      store.load(saved, 'load');
      startDraftScreen();
      banner(
        `Resumed your draft from ${new Date(saved.updatedAt).toLocaleString()} — ${saved.picks.length} picks.`,
        'info',
        []
      );
    } else {
      show('setup');
      App.views.setup.render(screens.setup.querySelector('.screen__body'), {
        onStart: startDraftScreen,
      });
    }

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* offline caching is a bonus, not a requirement */
      });
    }
  }

  App.readOnly = () => readOnly;
  document.addEventListener('DOMContentLoaded', boot);
})(window.DraftApp);
