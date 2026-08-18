(function (App) {
  'use strict';

  // Two ways to get the draft into a Google Sheet. They exist because they fail
  // in different places, and which one is less trouble depends on the operator:
  //
  //   'server'      -- the app's own /api/* endpoints, holding a service-account
  //                    key server-side. Needs a Google Cloud project to create
  //                    that key, but once deployed the operator does nothing.
  //
  //   'appsScript'  -- a script pasted into the spreadsheet itself and deployed
  //                    as a web app. No cloud project, no key file; the script
  //                    runs as whoever deployed it. The browser talks to Google
  //                    directly, so this is the only backend that works from the
  //                    standalone DraftBoard-offline.html file, which has no
  //                    server behind it at all.
  //
  // Both take the same calls and return the same shapes, so sync.js does not
  // know or care which one is in use.

  /** Normalized result: { status, data } -- HTTP-ish, whatever the transport did. */
  function result(status, data) {
    return { status, data: data || {} };
  }

  function serverBackend() {
    let token = '';

    function headers() {
      const h = { 'Content-Type': 'application/json' };
      if (token) h['X-Draft-Token'] = token;
      return h;
    }

    async function call(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      return result(res.status, data);
    }

    return {
      id: 'server',
      label: 'This app’s server',
      setToken(t) { token = t || ''; },

      push(state, { force = false, summary = '', client = '' } = {}) {
        return call('api/sync', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ state, force, summary, client }),
        });
      },

      list() {
        return call('api/state', { headers: headers() });
      },

      load(draftKey) {
        return call(`api/state?draft=${encodeURIComponent(draftKey)}`, { headers: headers() });
      },

      health() {
        return call('api/health', { headers: headers() });
      },
    };
  }

  function appsScriptBackend() {
    let token = '';
    let url = '';

    /**
     * Content-Type must stay text/plain. Anything else makes this a non-simple
     * cross-origin request, and the browser sends a CORS preflight that Apps
     * Script has no way to answer -- the request would fail before Google ever
     * saw it. The script reads the body as JSON regardless of this header.
     */
    /**
     * When Apps Script serves an error page instead of running the script, the
     * page carries no CORS headers and the browser rejects the fetch with a
     * bare "Failed to fetch" -- the useful part is unreadable from here. So on
     * failure, probe again with mode:'no-cors': that resolves for any response
     * at all, which separates "Google answered, the script did not" from "the
     * URL is wrong or the network is down".
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

    async function call(payload) {
      if (!url) return result(503, { ok: false, error: { code: 'not_configured', message: 'No Apps Script URL set.' } });

      // The /dev URL is the editor's private preview: it only works in a
      // browser already signed in as the script's owner, so it will fail for
      // the operator on the night. Catch it here rather than after a failure.
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

    return {
      id: 'appsScript',
      label: 'Apps Script in the spreadsheet',
      setToken(t) { token = t || ''; },
      setUrl(u) { url = (u || '').trim(); },
      get url() { return url; },

      /**
       * Sends finished rows rather than state. The mapping comes from
       * App.schema, which is generated from the same file the server uses, so
       * both backends write byte-identical spreadsheets.
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
        // Rebuilt with the same rowsToState() the server uses, so a restore
        // through either backend produces exactly the same draft.
        const state = App.schema.rowsToState(res.data);
        const found = Boolean(state && state.draftId);
        return result(200, { ok: true, found, state: found ? state : null });
      },

      health() {
        return call({ op: 'health' });
      },
    };
  }

  const backends = {
    server: serverBackend(),
    appsScript: appsScriptBackend(),
  };

  App.backends = {
    all: backends,
    get(id) {
      return backends[id] || backends.server;
    },
    /**
     * Opened from a file:// URL there is no server to talk to, so Apps Script
     * is the only backend that can work.
     */
    defaultId() {
      return window.location.protocol === 'file:' ? 'appsScript' : 'server';
    },
  };
})(window.DraftApp);
