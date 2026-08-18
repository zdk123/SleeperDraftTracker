(function (App) {
  'use strict';

  // Talks to the Google Apps Script web app deployed inside the operator's own
  // spreadsheet. That script runs as whoever deployed it, so there is no
  // service account, no key file, and no Google Cloud project anywhere.
  //
  // The browser posts finished spreadsheet rows straight to Google -- nothing
  // sits in between. That is what lets the standalone DraftBoard-offline.html
  // back up to a sheet with no server running at all, and it works identically
  // from a file:// page, the local server, and the hosted version.

  function result(status, data) {
    return { status, data: data || {} };
  }

  let token = '';
  let url = '';

  /**
   * When Apps Script serves an error page instead of running the script, the
   * page carries no CORS headers and the browser rejects the fetch with a bare
   * "Failed to fetch" -- the useful part is unreadable from here. So on
   * failure, probe again with mode:'no-cors': that resolves for any response at
   * all, which separates "Google answered, the script did not" from "the URL is
   * wrong or the network is down".
   */
  async function diagnose(err) {
    let answered = false;
    try {
      await fetch(url, { method: 'POST', mode: 'no-cors', body: '{}' });
      answered = true;
    } catch {
      /* nothing there at all */
    }

    if (answered) {
      return Object.assign(new Error('The script URL answered, but not with data.'), {
        code: 'not_deployed',
        hint:
          'Usually the deployment is older than the code. In Apps Script: save the file, ' +
          'then Deploy → Manage deployments → ✏️ → Version: New version → Deploy. ' +
          'Also check "Who has access" is Anyone.',
      });
    }
    return Object.assign(new Error(err.message || 'Could not reach the Apps Script URL.'), {
      code: 'unreachable',
      hint: /\/exec\s*$/.test(url)
        ? 'Nothing answered at that URL. Check it was copied whole, and that you are online.'
        : 'That URL should end in /exec — the /dev one only works while signed in as you.',
    });
  }

  /**
   * Content-Type must stay text/plain. Anything else makes this a non-simple
   * cross-origin request, and the browser sends a CORS preflight that Apps
   * Script has no way to answer -- the request would fail before Google ever
   * saw it. The script reads the body as JSON regardless of this header.
   */
  async function call(payload) {
    if (!url) {
      return result(503, {
        ok: false,
        error: { code: 'not_configured', message: 'No Apps Script URL set.' },
      });
    }

    // The /dev URL is the editor's private preview: it only works in a browser
    // already signed in as the script's owner, so it will fail for the operator
    // on the night. Catch it here rather than after a failure.
    if (/\/dev\/?$/.test(url)) {
      throw Object.assign(new Error('That is the /dev URL, which only works for you.'), {
        code: 'dev_url',
        hint: 'Use the deployment URL ending in /exec — Deploy → Manage deployments.',
      });
    }

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, token }),
        redirect: 'follow',
      });
    } catch (err) {
      throw await diagnose(err);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // HTML rather than JSON: a login page, or Apps Script's own error page.
      const notFound = /Script function not found/i.test(text);
      throw Object.assign(new Error('The script URL returned a page, not data.'), {
        code: notFound ? 'not_deployed' : 'not_shared',
        hint: notFound
          ? 'The deployed version has no doPost. Save Code.gs, then Deploy → Manage ' +
            'deployments → ✏️ → Version: New version → Deploy.'
          : 'Re-deploy the script with "Who has access" set to Anyone.',
      });
    }

    // Apps Script cannot set a status code, so it reports one in the body.
    return result(Number(data.status) || (data.ok ? 200 : 500), data);
  }

  App.backend = {
    setToken(t) { token = t || ''; },
    setUrl(u) { url = (u || '').trim(); },
    get url() { return url; },
    configured() { return Boolean(url); },

    /**
     * Sends finished rows rather than state. The mapping lives in
     * public/js/schema.js; the script just writes what it is handed.
     */
    push(state, { force = false, summary = '', client = '' } = {}) {
      return call({
        op: 'sync',
        draftKey: App.schema.draftKeyOf(state),
        draftId: state.draftId,
        revision: Number(state.revision) || 0,
        pickCount: (state.picks || []).length,
        ranges: App.schema.stateToRanges(state),
        indexRow: App.schema.indexRow(state),
        logRow: App.schema.logRow(state, { client, summary }),
        force,
      });
    },

    async list() {
      const res = await call({ op: 'list' });
      if (res.status !== 200) return res;
      return result(200, { ok: true, drafts: App.schema.parseIndex(res.data.rows || []) });
    },

    async load(draftKey) {
      const res = await call({ op: 'load', draftKey });
      if (res.status !== 200) return res;
      // Rebuilt with the same rowsToState() that wrote it.
      const state = App.schema.rowsToState(res.data);
      const found = Boolean(state && state.draftId);
      return result(200, { ok: true, found, state: found ? state : null });
    },

    health() {
      return call({ op: 'health' });
    },
  };
})(window.DraftApp);
