(function (App) {
  'use strict';

  const { store, bus } = App;

  // The read-only half of the app: keeps a guest's phone roughly in step with
  // the draft, and can do nothing else.
  //
  // Two ideas carry the whole design.
  //
  // 1. ASK CHEAPLY, FETCH RARELY. `poll` reads a handful of cells and returns a
  //    revision number; `load` reads three whole tabs and returns tens of
  //    kilobytes. Polling every few seconds is only affordable because the
  //    expensive call happens solely when the revision actually moved.
  //
  // 2. SPREAD THE HERD. Every phone detects the same revision bump within a
  //    second or two of the others, so jittering the poll is not enough -- it
  //    spreads *detection*, and they would still all fetch at once, right after
  //    each pick, while the operator's own write is in flight. The load gets its
  //    own random delay for that reason.
  //
  // tick() is deliberately callable on its own, with scheduling kept separate.
  // Anything else is untestable: the test sandbox stubs setInterval to a no-op,
  // and a suite that genuinely waited out 8-second polls could not run in CI.

  const POLL_MS = 8000;
  const POLL_JITTER = 0.25;
  const HIDDEN_MS = 60000;
  const LOAD_SPREAD_MS = 3000;
  const BACKOFF_BASE_MS = 4000;
  const BACKOFF_MAX_MS = 60000;

  // Freshness thresholds. Read by the UI; the point is that they measure time
  // since the last success, never the presence of an error.
  const STALE_MS = 45000;
  const DEAD_MS = 120000;

  let config = null;
  let knownRevision = -1;
  let lastSuccessAt = 0;
  let failures = 0;
  let phase = 'idle'; // idle | live | error | gone | unconfigured
  let detail = '';
  let timer = null;
  let stopped = true;
  const counts = { polls: 0, loads: 0 };

  // Injectable so tests can run the state machine in milliseconds and observe
  // the delays it asks for, rather than sitting through them.
  let deps = {
    now: () => Date.now(),
    random: () => Math.random(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  };

  function setPhase(next, message) {
    phase = next;
    detail = message || '';
    bus.emit('viewer:status', Viewer.snapshot());
  }

  /** How long until the next tick. Failure backoff wins over the normal cadence. */
  function nextDelayMs() {
    if (failures > 0) {
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      return Math.round(backoff * (1 + (deps.random() - 0.5) * POLL_JITTER * 2));
    }
    const base = deps.hidden() ? HIDDEN_MS : POLL_MS;
    return Math.round(base * (1 + (deps.random() - 0.5) * POLL_JITTER * 2));
  }

  /**
   * The random delay before a full load. Not cosmetic: it is what stops a dozen
   * phones fetching ~40KB apiece in the same instant after every pick.
   */
  function loadSpreadMs() {
    return Math.round(deps.random() * LOAD_SPREAD_MS);
  }

  async function loadDraft() {
    counts.loads += 1;
    const { status, data } = await App.backend.load(config.draftKey);
    if (status >= 400 || !data.ok) {
      throw new Error((data.error && data.error.message) || `HTTP ${status}`);
    }
    if (!data.found) return null;
    store.load(data.state, 'viewer');
    knownRevision = Number(data.state.revision) || 0;
    lastSuccessAt = deps.now();
    return data.state;
  }

  /**
   * One poll, and a load if the draft moved.
   *
   * @returns {{action: 'unchanged'|'loaded'|'first-load'|'gone'|'error'|'unconfigured'}}
   */
  async function tick() {
    if (!config) return { action: 'unconfigured' };

    try {
      // Nothing loaded yet: skip straight to the real thing.
      if (knownRevision < 0) {
        const state = await loadDraft();
        if (!state) return gone();
        failures = 0;
        setPhase('live');
        bus.emit('viewer:updated', { revision: knownRevision, first: true });
        return { action: 'first-load', revision: knownRevision };
      }

      counts.polls += 1;
      const { status, data } = await App.backend.poll(config.draftKey);
      if (status >= 400 || !data.ok) {
        throw new Error((data.error && data.error.message) || `HTTP ${status}`);
      }

      failures = 0;
      lastSuccessAt = deps.now();

      if (!data.found) return gone();

      if (Number(data.revision) === knownRevision) {
        // The common case, and the reason this is affordable at all.
        setPhase('live');
        return { action: 'unchanged', revision: knownRevision };
      }

      await deps.sleep(loadSpreadMs());
      const state = await loadDraft();
      if (!state) return gone();
      setPhase('live');
      bus.emit('viewer:updated', { revision: knownRevision, first: false });
      return { action: 'loaded', revision: knownRevision };
    } catch (err) {
      failures += 1;
      // Deliberately does NOT touch lastSuccessAt: freshness is measured from
      // the last good answer, so one dropped poll on patchy signal does not
      // make the screen shout.
      setPhase('error', err.hint || err.message || 'Could not reach the sheet.');
      return { action: 'error', error: err };
    }
  }

  /**
   * The pinned draft is not in the spreadsheet. That could mean it ended, but it
   * could equally mean the link is mistyped or the operator redeployed to a
   * different URL -- so offer the alternative by name and let the guest decide,
   * rather than silently swapping them onto some other league's draft.
   */
  async function gone() {
    setPhase('gone', 'That draft is not in this spreadsheet.');
    let drafts = [];
    try {
      const { status, data } = await App.backend.list();
      if (status < 400 && data.ok) drafts = data.drafts || [];
    } catch {
      /* the offer is a courtesy; failing to make it is not an error */
    }
    const newest = drafts.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))[0];
    bus.emit('viewer:gone', { drafts, suggestion: newest || null });
    return { action: 'gone', suggestion: newest || null };
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(run, nextDelayMs());
  }

  async function run() {
    await tick();
    schedule();
  }

  const Viewer = {
    POLL_MS,
    STALE_MS,
    DEAD_MS,

    /** Point at one draft. Does not fetch; call tick() or start(). */
    connect({ url, token, draftKey }) {
      config = { url, token, draftKey };
      knownRevision = -1;
      failures = 0;
      lastSuccessAt = 0;
      App.backend.setUrl(url);
      App.backend.setToken(token);
      setPhase('idle');
      return config;
    },

    configured() {
      return Boolean(config && config.url && config.draftKey);
    },

    draftKey() {
      return config ? config.draftKey : '';
    },

    tick,

    async start() {
      stopped = false;
      await run();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
    },

    /** Poll now -- used when the page becomes visible again. */
    async refresh() {
      clearTimeout(timer);
      const result = await tick();
      schedule();
      return result;
    },

    /** For tests, and for the "how stale am I" clock the UI draws. */
    inject(overrides) {
      deps = { ...deps, ...overrides };
    },

    counts() {
      return { ...counts };
    },

    /**
     * Freshness is time since the last successful answer -- never the error
     * flag. On venue cellular a single dropped poll is routine, and flashing a
     * warning while the data is six seconds old just teaches people to ignore
     * it. Sustained failure still turns this red, via the clock.
     */
    freshness() {
      if (!lastSuccessAt) return { level: 'unknown', ageMs: null };
      const ageMs = deps.now() - lastSuccessAt;
      if (ageMs >= DEAD_MS) return { level: 'dead', ageMs };
      if (ageMs >= STALE_MS) return { level: 'stale', ageMs };
      return { level: 'fresh', ageMs };
    },

    snapshot() {
      return {
        phase,
        detail,
        revision: knownRevision,
        lastSuccessAt,
        failures,
        ...Viewer.freshness(),
      };
    },
  };

  App.viewer = Viewer;
})(window.DraftApp);
