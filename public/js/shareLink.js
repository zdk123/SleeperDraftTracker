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
  const SETUP_PREFIX = '#s1.';

  // Every Apps Script deployment URL is this boilerplate wrapped around one id.
  // Stripping it costs nothing and saves 40 characters, which is the difference
  // between a 61x61 QR code and a 53x53 one -- i.e. 15% bigger modules on the
  // TV for the same area, which is the whole game when scanning from a sofa.
  const SCRIPT_PREFIX = 'https://script.google.com/macros/s/';
  const SCRIPT_SUFFIX = '/exec';

  function packUrl(url) {
    const trimmed = String(url || '').trim();
    if (trimmed.startsWith(SCRIPT_PREFIX) && trimmed.endsWith(SCRIPT_SUFFIX)) {
      return trimmed.slice(SCRIPT_PREFIX.length, -SCRIPT_SUFFIX.length);
    }
    // Anything else (a test harness, a proxy) travels whole.
    return trimmed;
  }

  function unpackUrl(packed) {
    const value = String(packed || '');
    return /^https?:\/\//.test(value) ? value : SCRIPT_PREFIX + value + SCRIPT_SUFFIX;
  }

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
      return PREFIX + toBase64Url(JSON.stringify({ u: packUrl(url), t: token || '', k: draftKey || '' }));
    },

    // --- the operator's setup link -----------------------------------------
    //
    // A different thing from the viewer link above, and far more sensitive: it
    // carries the WRITE token, so whoever holds it can save over the draft.
    // It exists so the person running the draft doesn't have to hand-type a
    // deployment id and two tokens on the night.
    //
    // Send it directly to that one person. Never to the league chat, and never
    // in the same message as the viewer link.

    /** @returns the fragment alone, e.g. "#s1.eyJ...". */
    encodeSetup({ scriptUrl, token, viewToken }) {
      return (
        SETUP_PREFIX +
        toBase64Url(
          JSON.stringify({ d: packUrl(scriptUrl), t: token || '', v: viewToken || '' })
        )
      );
    },

    buildSetup({ origin, scriptUrl, token, viewToken }) {
      const base = String(origin || '').replace(/\/(index\.html)?$/, '');
      return `${base}/index.html${App.shareLink.encodeSetup({ scriptUrl, token, viewToken })}`;
    },

    /**
     * @returns {{scriptUrl, token, viewToken}} or null. Like decode(), never
     *   throws -- a fragment mangled by a chat client must leave the operator
     *   on a normal setup screen, not a broken page.
     */
    decodeSetup(hash) {
      const raw = String(hash || '');
      if (!raw.startsWith(SETUP_PREFIX)) return null;
      try {
        const parsed = JSON.parse(fromBase64Url(raw.slice(SETUP_PREFIX.length)));
        if (!parsed || typeof parsed !== 'object') return null;
        const out = {
          scriptUrl: parsed.d ? unpackUrl(parsed.d) : '',
          token: String(parsed.t || ''),
          viewToken: String(parsed.v || ''),
        };
        return out.scriptUrl ? out : null;
      } catch {
        return null;
      }
    },

    /** Which kind of link, if any, is in this fragment. */
    kindOf(hash) {
      const raw = String(hash || '');
      if (raw.startsWith(PREFIX)) return 'viewer';
      if (raw.startsWith(SETUP_PREFIX)) return 'setup';
      return null;
    },

    /**
     * Whether a link generated here would actually work in someone else's
     * hands, and if not, why. Both the Share panel and the board's QR code ask
     * this -- two copies of the reasoning would eventually disagree, and the
     * failure mode is handing out a link that silently does nothing.
     *
     * @returns {{ok: boolean, reason: string}} reason is '' when ok.
     */
    availability({ protocol, hostname, scriptUrl, viewToken, writeToken } = {}) {
      // file:// has no address at all; localhost means "this phone" to every
      // guest who opens it.
      if (!String(protocol || '').startsWith('http')) return { ok: false, reason: 'file' };
      if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
        return { ok: false, reason: 'local' };
      }
      if (!scriptUrl) return { ok: false, reason: 'no-sheet' };
      if (!viewToken) return { ok: false, reason: 'no-token' };
      // A viewer link built from the write token would let anyone holding it
      // overwrite the draft, which is the one thing viewer mode must not allow.
      if (writeToken && viewToken === writeToken) return { ok: false, reason: 'same-token' };
      return { ok: true, reason: '' };
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
          url: parsed.u ? unpackUrl(parsed.u) : '',
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
