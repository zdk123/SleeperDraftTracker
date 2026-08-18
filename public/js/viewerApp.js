(function (App) {
  'use strict';

  const { el, clear } = App.utils;
  const { store, persistence, viewer } = App;

  // Boot for view.html. Deliberately small, and deliberately missing things:
  // no session lock, no persistence.save, no sync, no player list. The page
  // cannot write to the draft because the code that writes was never loaded.

  const root = () => document.getElementById('view-root');

  let teamId = null;
  let renderTimer = null;

  function teamPrefKey() {
    // Namespaced: prefs is one flat object shared with the operator's app on the
    // same origin, where `token` and `appsScriptUrl` already live.
    return `viewer.${viewer.draftKey()}.teamId`;
  }

  function fail(message, hint) {
    clear(root()).append(
      el('div', { class: 'vmessage' }, [
        el('h1', { text: message }),
        hint ? el('p', { class: 'muted', text: hint }) : null,
      ])
    );
  }

  function draw() {
    if (!store.exists()) return;
    if (!teamId) {
      App.views.viewerBoard.renderTeamPicker(root(), {
        onPick: (id) => {
          teamId = id;
          persistence.setPref(teamPrefKey(), id);
          draw();
        },
      });
      return;
    }
    App.views.viewerBoard.render(root(), {
      teamId,
      freshness: viewer.freshness(),
      phase: viewer.snapshot().phase,
      onChangeTeam: () => {
        teamId = null;
        persistence.setPref(teamPrefKey(), '');
        draw();
      },
    });
  }

  async function boot() {
    // Theme, same tokens as the operator app.
    const saved = persistence.prefs().theme;
    document.documentElement.dataset.theme =
      saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

    const link = App.shareLink.decode(window.location.hash);
    if (!link) {
      fail(
        'This link is missing or incomplete.',
        'Ask whoever is running the draft to send the viewer link again — chat apps sometimes cut long links in half.'
      );
      return;
    }

    viewer.connect(link);
    teamId = persistence.prefs()[teamPrefKey()] || null;
    clear(root()).append(el('div', { class: 'vmessage' }, [el('h1', { text: 'Loading the draft…' })]));

    App.bus.on('viewer:updated', draw);
    App.bus.on('viewer:status', () => {
      // Only repaint on a state change; the freshness clock has its own timer.
      if (store.exists() && teamId) return;
      draw();
    });

    App.bus.on('viewer:gone', ({ suggestion }) => {
      clear(root()).append(
        el('div', { class: 'vmessage' }, [
          el('h1', { text: 'That draft is not in this spreadsheet.' }),
          el('p', {
            class: 'muted',
            text: suggestion
              ? 'It may have finished, or this link may point somewhere unexpected.'
              : 'It may have finished, or this link may be for a different spreadsheet.',
          }),
          suggestion
            ? el('button', {
                class: 'btn btn--primary btn--lg',
                // Name it: "open the current one" would happily drop a guest
                // into an unrelated league's draft if the link were wrong.
                text: `Open “${suggestion.name || suggestion.draftKey}” instead`,
                onclick: () => {
                  viewer.connect({ ...link, draftKey: suggestion.draftKey });
                  teamId = persistence.prefs()[teamPrefKey()] || null;
                  viewer.start();
                },
              })
            : null,
        ])
      );
    });

    const first = await viewer.tick();
    if (first.action === 'error') {
      fail(
        'Could not reach the draft.',
        (first.error && (first.error.hint || first.error.message)) ||
          'Check you have a signal, then reload this page.'
      );
    }
    draw();
    viewer.start();

    // The freshness line is a clock, so it has to tick even when nothing else
    // changes -- that is exactly the case it exists to report.
    renderTimer = setInterval(() => {
      if (store.exists() && teamId) draw();
    }, 5000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') viewer.refresh();
    });
    window.addEventListener('beforeunload', () => {
      viewer.stop();
      clearInterval(renderTimer);
    });
  }

  // Belt and braces. The page never loads a mutation path, but if a future
  // shared view ever tries one, the store refuses it rather than pretending.
  store.setReadOnly(true);

  document.addEventListener('DOMContentLoaded', boot);
})(window.DraftApp);
