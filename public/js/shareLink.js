(function (App) {
  'use strict';

  // The viewer link: everything a guest's phone needs to read one draft, packed
  // into a URL that can be pasted into a group chat.
  //
  // Three things travel: the Apps Script deployment URL, the read-only token,
  // and which draft to show. There is no server to hold any of it -- the app is
  // static -- so the link is the only place it can live.
  //
  // It goes in the hash fragment rather than the query string because fragments
  // are never sent to the server, so the token stays out of Vercel's request
  // logs and out of any proxy in between.

  const PREFIX = '#v1.';

  /**
   * btoa() throws on anything outside Latin-1, and a draft key can easily carry
   * a character that is: draftKey() strips only : \ / ? * [ ] ' " , so a league
   * called "Café" or one with an emoji in the name flows straight through. So
   * encode to UTF-8 bytes first and base64 those.
   */
  function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(encoded) {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  App.shareLink = {
    /**
     * @returns the fragment alone, e.g. "#v1.eyJ1Ijoi...". Callers join it to
     *   whatever origin they are serving from.
     */
    encode({ url, token, draftKey }) {
      return PREFIX + toBase64Url(JSON.stringify({ u: url || '', t: token || '', k: draftKey || '' }));
    },

    /** Builds the whole link a guest opens. */
    build({ origin, url, token, draftKey }) {
      const base = String(origin || '').replace(/\/(index\.html)?$/, '');
      return `${base}/view.html${App.shareLink.encode({ url, token, draftKey })}`;
    },

    /**
     * @returns {{url, token, draftKey}} or null if there is nothing usable here.
     *   Never throws: a mangled link (truncated by a chat client, hand-edited)
     *   has to land on the viewer's "this link doesn't work" screen, not on an
     *   uncaught exception that leaves a guest staring at a blank page.
     */
    decode(hash) {
      const raw = String(hash || '');
      if (!raw.startsWith(PREFIX)) return null;
      try {
        const parsed = JSON.parse(fromBase64Url(raw.slice(PREFIX.length)));
        if (!parsed || typeof parsed !== 'object') return null;
        const out = {
          url: String(parsed.u || ''),
          token: String(parsed.t || ''),
          draftKey: String(parsed.k || ''),
        };
        return out.url && out.draftKey ? out : null;
      } catch {
        return null;
      }
    },
  };
})(window.DraftApp);
