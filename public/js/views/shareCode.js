(function (App) {
  'use strict';

  const { el, clear } = App.utils;
  const { store, persistence } = App;

  // The QR code on the draft board.
  //
  // Mounted once into its own element rather than drawn inside board.render():
  // the board is cleared and rebuilt after every single pick, and regenerating
  // ~1,400 SVG subpaths 140 times over an evening is work for nothing. The link
  // cannot change mid-draft anyway -- it is the spreadsheet, the token and the
  // draft key, none of which move once the draft has started.
  //
  // Small by default. A code big enough to scan from the sofa is roughly a
  // fifth of the screen, which is too much to give up permanently on a board
  // already fitting a dozen team columns -- so it enlarges on demand instead.

  let host = null;
  let overlay = null;
  let currentLink = '';

  function currentAvailability() {
    const prefs = persistence.prefs();
    return App.shareLink.availability({
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      scriptUrl: prefs.appsScriptUrl || '',
      viewToken: prefs.viewToken || '',
      writeToken: prefs.token || '',
    });
  }

  function buildLink() {
    const prefs = persistence.prefs();
    return App.shareLink.build({
      origin: window.location.origin + window.location.pathname.replace(/[^/]*$/, ''),
      url: prefs.appsScriptUrl,
      token: prefs.viewToken,
      draftKey: store.get().draftKey,
    });
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.classList.remove('has-qr-overlay');
  }

  /** The "everyone scan now" moment: as large as the screen allows. */
  function openOverlay() {
    if (overlay || !currentLink) return;
    overlay = el('div', { class: 'qr-overlay', onclick: closeOverlay }, [
      el('div', { class: 'qr-overlay__inner' }, [
        el('h2', { class: 'qr-overlay__title', text: 'Scan to follow your team' }),
        el('div', { class: 'qr-overlay__code' }, [App.views.qrcode.render(currentLink)]),
        el('p', {
          class: 'qr-overlay__sub',
          text: 'Point your camera at this. You’ll see your own roster and budget — you can’t change the draft.',
        }),
        el('p', { class: 'qr-overlay__dismiss', text: 'Click anywhere, or press Esc, to go back to the board' }),
      ]),
    ]);
    document.body.append(overlay);
    document.body.classList.add('has-qr-overlay');
  }

  App.views = App.views || {};
  App.views.shareCode = {
    /**
     * Draws the code, or hides the whole element if a link from here would not
     * work in someone else's hands. Safe to call again; only redraws when the
     * link actually changed.
     */
    mount(container) {
      host = container;
      const { ok } = currentAvailability();
      if (!ok) {
        host.hidden = true;
        currentLink = '';
        clear(host);
        return null;
      }

      const link = buildLink();
      if (link === currentLink && host.firstChild) {
        host.hidden = false;
        return link;
      }
      currentLink = link;

      clear(host);
      host.hidden = false;
      host.append(
        el('button', {
          class: 'board-qr__btn',
          title: 'Show a large code for everyone to scan',
          'aria-label': 'Enlarge the QR code for guests to scan',
          onclick: openOverlay,
        }, [App.views.qrcode.render(link)]),
        el('div', { class: 'board-qr__cap', text: 'Scan to follow' })
      );
      return link;
    },

    open: openOverlay,
    close: closeOverlay,
    isOpen: () => Boolean(overlay),
    link: () => currentLink,
  };
})(window.DraftApp);
