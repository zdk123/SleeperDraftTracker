(function (App) {
  'use strict';

  const { el, clear } = App.utils;
  const { persistence } = App;

  // Builds the link that hands the whole spreadsheet setup to whoever is
  // actually running the draft, so they don't type a deployment id and two
  // tokens from a phone screen while a room waits.
  //
  // Rendered in two places, from one function: the setup screen (where the
  // settings are entered) and the recovery panel (where you'd need it if the
  // draft laptop died and a second one has to be configured in a hurry).

  /**
   * @param {object} [override] values to use instead of what's in prefs --
   *   the setup screen passes the live contents of its inputs, which may not
   *   have been committed to prefs yet.
   */
  function currentValues(override) {
    const prefs = persistence.prefs();
    return {
      scriptUrl: (override && override.scriptUrl) || prefs.appsScriptUrl || '',
      token: (override && override.token) || prefs.token || '',
      viewToken: (override && override.viewToken) || prefs.viewToken || '',
    };
  }

  App.views = App.views || {};
  App.views.setupLink = {
    /**
     * @param {HTMLElement} host
     * @param {function} [read] returns {scriptUrl, token, viewToken} at click
     *   time, so the link reflects what is on screen right now.
     */
    render(host, read) {
      clear(host);
      const status = el('div', { class: 'note-slot' });
      const box = el('textarea', { class: 'copybox', readonly: true, rows: '3', hidden: true });

      host.append(
        el('p', {
          class: 'muted small',
          text:
            'Running the draft on someone else’s laptop? This link fills all three boxes above ' +
            'for them, so there is nothing to type on the night.',
        }),
        el('div', { class: 'field-row' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--ghost',
            text: 'Copy a setup link',
            onclick: async (e) => {
              const values = currentValues(read ? read() : null);
              if (!values.scriptUrl) {
                clear(status).append(
                  el('span', {
                    class: 'note note--warn',
                    text: 'Add the web app URL first — there is nothing to send yet.',
                  })
                );
                return;
              }

              const link = App.shareLink.buildSetup({
                origin: window.location.origin + window.location.pathname.replace(/[^/]*$/, ''),
                ...values,
              });
              box.value = link;
              box.hidden = false;

              try {
                await navigator.clipboard.writeText(link);
                clear(status).append(el('span', { class: 'note note--ok', text: 'Copied.' }));
              } catch {
                box.select();
                clear(status).append(
                  el('span', { class: 'note note--info', text: 'Press Ctrl/Cmd+C to copy.' })
                );
              }
              e.target.blur();
            },
          }),
        ]),
        box,
        // Said plainly, because the consequence is not obvious from the link.
        el('p', {
          class: 'muted small',
          text:
            '⚠ This one contains your access token — whoever opens it can save over the draft. ' +
            'Send it straight to the person running the draft, not to the league chat, and not ' +
            'in the same message as the viewer link.',
        }),
        status
      );
    },
  };
})(window.DraftApp);
