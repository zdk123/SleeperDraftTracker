#!/usr/bin/env node
// Full-draft simulations looking for data loss.
//
// Each scenario runs a COMPLETE auction (every team, every roster spot) through
// the real app in a real browser, then reconciles four independent copies of
// the truth against each other:
//
//   1. what the simulation intended to enter
//   2. what the app's in-memory state holds
//   3. what survived into localStorage
//   4. what the Google Sheet received (where that mode has one)
//
// plus the exports, since that's what actually gets typed into Sleeper. A
// scenario only passes if all of them agree exactly.
//
// Run with: node --experimental-websocket scripts/simulate.mjs [scenario]

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { startFakeAppsScript } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tabs are now named "<draft key> <Kind>" and quoted in A1 ranges. */
function tabRows(sheet, kind) {
  for (const [range, values] of sheet.values) {
    const tab = range.split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'");
    if (tab.endsWith(' ' + kind)) return values;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The app's own server: static files only, for an http:// origin.
// ---------------------------------------------------------------------------

function startAppServer(port) {
  return spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), SIM_APP_SERVER: '1' },
    stdio: 'ignore',
  });
}

/**
 * Fails fast if a server from an earlier crashed run still holds the port. It
 * would answer requests with stale code, which silently invalidates everything
 * the simulation then measures.
 */
async function assertPortFree(port, what) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      throw new Error(
        `${what}: port ${port} is already in use — a server from an earlier run is still ` +
          `there and would serve stale code (pkill -f "node server.js")`
      );
    }
  } catch (err) {
    if (err.message.includes('already in use')) throw err;
    /* nothing listening: good */
  }
}

/** Polls until the app server actually answers, rather than guessing a delay. */
async function waitForServer(port, what) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`${what} never came up on port ${port} (is something else using it?)`);
}

// ---------------------------------------------------------------------------
// Chrome driver
// ---------------------------------------------------------------------------

class Browser {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }

  async launch(port) {
    // A Chrome left behind by an earlier crashed run would still be listening
    // here, and attaching to it silently inherits its localStorage -- which
    // looks exactly like a resumed draft and invalidates the whole simulation.
    // Refuse to attach to anything we didn't just start.
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        throw new Error(
          `something is already listening on debug port ${port} — kill stale Chrome ` +
            `instances first (pkill -f "remote-debugging-port=${port}")`
        );
      }
    } catch (err) {
      if (err.message.includes('already listening')) throw err;
      /* nothing there: good */
    }

    this.debugPort = port;
    this.profile = await mkdtemp(join(tmpdir(), 'sim-chrome-'));
    this.chrome = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profile}`,
        '--no-first-run',
        '--disable-gpu',
        '--window-size=1600,1000',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    let wsUrl;
    for (let i = 0; i < 60; i += 1) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find((t) => t.type === 'page');
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* starting */
      }
      await sleep(200);
    }
    if (!wsUrl) throw new Error('Chrome did not start');

    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(
          msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text
        );
      }
    });

    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Network.enable');
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  goto(url) {
    return this.send('Page.navigate', { url });
  }

  /** Waits for the app to actually finish booting, rather than guessing. */
  async waitFor(expression, what, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression)) return;
      } catch (err) {
        lastError = err.message;
      }
      await sleep(150);
    }
    // Explain the failure instead of just reporting a timeout.
    const diag = await this.eval(`JSON.stringify({
      url: location.href,
      app: typeof window.DraftApp,
      screen: document.body && document.body.dataset.screen,
      rows: document.querySelectorAll('.team-row').length,
      players: window.DraftApp ? DraftApp.players.count() : -1,
      body: document.body ? document.body.innerHTML.length : -1
    })`).catch((e) => `diagnostics failed: ${e.message}`);
    throw new Error(
      `timed out waiting for ${what}\n         page: ${diag}` +
        (lastError ? `\n         last eval error: ${lastError}` : '') +
        (this.pageErrors.length ? `\n         page errors: ${this.pageErrors.slice(0, 2).join(' | ')}` : '')
    );
  }

  /**
   * A second tab in the SAME Chrome, so it shares localStorage with the first.
   * That sharing is the whole point: two windows on one draft is the scenario
   * the session lock exists for.
   */
  async openSecondTab(url) {
    const created = await (
      await fetch(`http://127.0.0.1:${this.debugPort}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
      })
    ).json();

    const tab = new Browser();
    tab.debugPort = this.debugPort;
    tab.ws = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      tab.ws.addEventListener('open', res, { once: true });
      tab.ws.addEventListener('error', rej, { once: true });
    });
    tab.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && tab.pending.has(msg.id)) {
        const { resolve, reject } = tab.pending.get(msg.id);
        tab.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        tab.pageErrors.push(
          msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text
        );
      }
    });
    await tab.send('Runtime.enable');
    await tab.send('Page.enable');
    // It shares the parent's Chrome, so it must not kill it on close.
    tab.chrome = null;
    tab.profile = null;
    return tab;
  }

  setOffline(offline) {
    return this.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }

  async close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    if (!this.chrome) return; // a second tab: the parent owns the browser
    this.chrome.kill();
    for (let i = 0; i < 5; i += 1) {
      try {
        await rm(this.profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Draft plan: a complete, realistic auction
// ---------------------------------------------------------------------------

const TEAMS = [
  'Gridiron Goblins', 'Sunday Scaries', 'Pylon Pirates', 'Blitz Brigade', 'Hail Mary Inc',
  'Turf Toe Terrors', 'Red Zone Rebels', 'Play Action Pals', 'Cleat Chasers', 'Audible Anarchy',
];
const BUDGET = 200;
const SLOTS = [
  { key: 'QB', count: 1, pos: ['QB'] },
  { key: 'RB', count: 2, pos: ['RB'] },
  { key: 'WR', count: 2, pos: ['WR'] },
  { key: 'TE', count: 1, pos: ['TE'] },
  { key: 'FLEX', count: 1, pos: ['RB', 'WR', 'TE'] },
  { key: 'DEF', count: 1, pos: ['DEF'] },
  { key: 'K', count: 1, pos: ['K'] },
  { key: 'BENCH', count: 5, pos: ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'] },
];
const SPOTS_PER_TEAM = SLOTS.reduce((s, x) => s + x.count, 0); // 14
const TOTAL_PICKS = TEAMS.length * SPOTS_PER_TEAM; // 140

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

let totalPass = 0;
let totalFail = 0;
const failures = [];

function check(scenario, name, ok, detail) {
  if (ok) {
    totalPass += 1;
    console.log(`    ok   ${name}`);
  } else {
    totalFail += 1;
    failures.push(`${scenario}: ${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`    FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
  }
}

/** Normalised comparison key for one pick. */
function fingerprint(p) {
  return `${p.playerId}|${p.playerName}|${p.teamName}|${p.price}`;
}

async function reconcile(scenario, browser, intended, sheet) {
  // --- 2. in-memory state
  const live = await browser.eval(`(() => {
    const s = DraftApp.store.get();
    return JSON.stringify(s.picks.map(p => ({
      playerId: p.playerId, playerName: p.playerName, price: p.price,
      teamName: (DraftApp.store.teamById(p.teamId)||{}).name, slot: p.slot
    })));
  })()`);
  const livePicks = JSON.parse(live);

  check(scenario, `app holds all ${intended.length} picks`, livePicks.length === intended.length,
    `got ${livePicks.length}`);

  const intendedFps = intended.map(fingerprint).sort();
  const liveFps = livePicks.map(fingerprint).sort();
  check(scenario, 'every pick matches what was entered', JSON.stringify(intendedFps) === JSON.stringify(liveFps),
    firstDiff(intendedFps, liveFps));

  // No duplicate players anywhere.
  const ids = livePicks.map((p) => p.playerId).filter(Boolean);
  check(scenario, 'no player drafted twice', new Set(ids).size === ids.length);

  // Every pick sits in a distinct roster slot for its team.
  const slotKeys = livePicks.map((p) => `${p.teamName}::${p.slot}`);
  check(scenario, 'no two picks share a roster spot', new Set(slotKeys).size === slotKeys.length);

  // --- budget integrity
  const budgets = await browser.eval(`(() => {
    const s = DraftApp.store.get();
    return JSON.stringify(s.teams.map(t => ({ name: t.name, ...DraftApp.store.teamSummary(t.id) })));
  })()`);
  const summaries = JSON.parse(budgets);
  const overspent = summaries.filter((t) => t.spent > BUDGET);
  check(scenario, 'no team exceeded its budget', overspent.length === 0,
    overspent.map((t) => `${t.name} spent ${t.spent}`).join(', '));
  const negative = summaries.filter((t) => t.remaining < 0);
  check(scenario, 'no negative balances', negative.length === 0);

  const expectedSpend = {};
  for (const p of intended) expectedSpend[p.teamName] = (expectedSpend[p.teamName] || 0) + p.price;
  const spendMismatch = summaries.filter((t) => (expectedSpend[t.name] || 0) !== t.spent);
  check(scenario, 'per-team spend matches the entered prices', spendMismatch.length === 0,
    spendMismatch.map((t) => `${t.name}: app ${t.spent} vs entered ${expectedSpend[t.name] || 0}`).join('; '));

  // --- 3. localStorage
  const stored = await browser.eval(`(() => {
    try {
      const s = JSON.parse(localStorage.getItem('sleeperDraftTracker.state.v1'));
      return JSON.stringify(s.picks.map(p => ({
        playerId: p.playerId, playerName: p.playerName, price: p.price, slot: p.slot,
        teamName: (s.teams.find(t => t.id === p.teamId)||{}).name
      })));
    } catch (e) { return '[]'; }
  })()`);
  const storedPicks = JSON.parse(stored);
  check(scenario, 'localStorage holds the complete draft', storedPicks.length === intended.length,
    `got ${storedPicks.length}`);
  check(scenario, 'localStorage matches the live state',
    JSON.stringify(storedPicks.map(fingerprint).sort()) === JSON.stringify(liveFps));

  // --- exports (what actually gets typed into Sleeper)
  const csv = await browser.eval('DraftApp.exporter.picksCsv()');
  const csvRows = csv.trim().split('\r\n').length - 1;
  check(scenario, 'pick CSV exports every row', csvRows === intended.length, `got ${csvRows}`);

  const rosterText = await browser.eval('DraftApp.exporter.rostersText()');
  const missingFromText = intended.filter((p) => !rosterText.includes(p.playerName));
  check(scenario, 'roster export names every player', missingFromText.length === 0,
    missingFromText.slice(0, 3).map((p) => p.playerName).join(', '));

  const rostersCsv = await browser.eval('DraftApp.exporter.rostersCsv()');
  const missingFromCsv = intended.filter((p) => !rostersCsv.includes(p.playerName));
  check(scenario, 'roster CSV names every player', missingFromCsv.length === 0,
    missingFromCsv.slice(0, 3).map((p) => p.playerName).join(', '));

  // --- 4. the sheet
  if (sheet) {
    const picksRows = tabRows(sheet, 'Picks');
    check(scenario, 'sheet received a Picks tab', Boolean(picksRows));
    if (picksRows) {
      const rows = picksRows.slice(1).filter((r) => r[2]);
      check(scenario, 'sheet holds every pick', rows.length === intended.length, `got ${rows.length}`);

      const sheetFps = rows
        .map((r) => `${r[5]}|${r[2]}|${r[6]}|${r[8]}`)
        .sort();
      check(scenario, 'sheet rows match the app exactly',
        JSON.stringify(sheetFps) === JSON.stringify(liveFps), firstDiff(liveFps, sheetFps));

      const blanks = picksRows.slice(1 + rows.length).filter((r) => r.some((c) => c !== ''));
      check(scenario, 'no stale rows left below the data', blanks.length === 0,
        `${blanks.length} dirty rows`);
    }

    const rosterFlat = JSON.stringify(tabRows(sheet, 'Rosters') || []);
    const missingRoster = intended.filter((p) => !rosterFlat.includes(p.playerName));
    check(scenario, 'sheet Rosters tab names every player', missingRoster.length === 0,
      missingRoster.slice(0, 3).map((p) => p.playerName).join(', '));

    // Restore path: rebuild from the sheet and confirm it round-trips. Goes
    // through sync.fetchRemote so whichever backend is configured is the one
    // actually exercised.
    const restored = await browser.eval(`
      DraftApp.sync.fetchRemote(DraftApp.store.get().draftKey)
        .then(d => JSON.stringify({
        found: d.found,
        count: d.state ? d.state.picks.length : -1,
        fps: d.state ? d.state.picks.map(p => p.playerId + '|' + p.playerName + '|' +
          ((d.state.teams.find(t => t.id === p.teamId)||{}).name) + '|' + p.price).sort() : []
      })).catch(e => JSON.stringify({error: e.message}))
    `);
    const r = JSON.parse(restored);
    check(scenario, 'draft can be rebuilt from the sheet alone', r.found && r.count === intended.length,
      `found=${r.found} count=${r.count}`);
    if (r.fps) {
      check(scenario, 'rebuilt draft matches pick-for-pick',
        JSON.stringify(r.fps) === JSON.stringify(liveFps), firstDiff(liveFps, r.fps));
    }
  }

  check(scenario, 'no uncaught errors during the draft', browser.pageErrors.length === 0,
    browser.pageErrors.slice(0, 2).join(' | '));
}

function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `first difference at ${i}: expected ${a[i]} got ${b[i]}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Driving a full draft through the real UI
// ---------------------------------------------------------------------------

/**
 * Point the app at a spreadsheet before the draft starts, the way the operator
 * does: type into the setup fields and let the change handlers apply them.
 */
async function configureSheet(browser, url, token = '') {
  await browser.eval(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', {bubbles:true})); };
    set(document.getElementById('apps-script-url'), ${JSON.stringify(url)});
    set(document.getElementById('token'), ${JSON.stringify(token)});
  })()`);
}

/** Flush the debounce and wait for the sheet to catch up. */
async function settleSync(browser, tries = 30) {
  await browser.eval(`DraftApp.sync.flushNow('simulation end')`);
  for (let i = 0; i < tries; i += 1) {
    const s = JSON.parse(await browser.eval('JSON.stringify(DraftApp.sync.snapshot())'));
    if (s.status === 'synced' && !s.dirty) return true;
    await sleep(400);
  }
  return false;
}

async function setupDraft(browser) {
  await browser.eval(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
    const names = ${JSON.stringify(TEAMS)};
    const rows = () => [...document.querySelectorAll('.team-row')];
    while (rows().length > names.length) rows()[rows().length-1].querySelector('.btn--icon').click();
    while (rows().length < names.length) {
      [...document.querySelectorAll('.btn')].find(b => b.textContent === '+ Add team').click();
    }
    rows().forEach((r, i) => {
      const ins = r.querySelectorAll('input');
      set(ins[0], names[i]); set(ins[1], 'mgr' + (i+1));
    });
    set(document.getElementById('budget'), '${BUDGET}');
    set(document.getElementById('reserve'), '1');
    const counts = ${JSON.stringify(SLOTS.map((s) => s.count))};
    [...document.querySelectorAll('.slot-row input')].forEach((inp, i) => set(inp, String(counts[i] ?? 0)));
  })()`);
  await sleep(200);
  const rowCount = await browser.eval('document.querySelectorAll(".team-row").length');
  if (rowCount !== TEAMS.length) {
    throw new Error(`setup produced ${rowCount} team rows, expected ${TEAMS.length} — did the page load?`);
  }
  await browser.eval(`[...document.querySelectorAll('.btn')].find(b => b.textContent === 'Start draft').click()`);
  await sleep(400);
}

/**
 * Plays a complete auction through the actual entry form, choosing prices that
 * respect the app's own max-bid rule so the draft can legally finish.
 */
async function runFullDraft(browser, { seed = 7, onPick } = {}) {
  const rand = rng(seed);
  const intended = [];
  const skipped = [];

  for (let i = 0; i < TOTAL_PICKS; i += 1) {
    // Ask the app which teams can still bid and what they can afford.
    const stateJson = await browser.eval(`(() => {
      const S = DraftApp.store, st = S.get();
      return JSON.stringify(st.teams.map(t => ({
        id: t.id, name: t.name, ...S.teamSummary(t.id),
        needs: S.openSlotCodes(t.id).map(s => s.eligiblePositions).flat()
      })));
    })()`);
    const teams = JSON.parse(stateJson).filter((t) => t.open > 0);
    if (!teams.length) break;

    const team = teams[Math.floor(rand() * teams.length)];
    const wantedPos = team.needs[Math.floor(rand() * team.needs.length)] || 'RB';

    // Pick an undrafted player at that position, preferring recognisable ones
    // the way a room actually drafts.
    const player = JSON.parse(
      await browser.eval(`(() => {
        const drafted = DraftApp.store.draftedPlayerIds();
        const pool = DraftApp.players.all()
          .filter(p => p.p === '${wantedPos}' && !drafted.has(p.id))
          .slice(0, 40);
        return JSON.stringify(pool[${Math.floor(rand() * 1e6)} % Math.max(pool.length, 1)] || null);
      })()`)
    );
    if (!player) continue;

    const maxAffordable = Math.max(1, team.maxBid);
    const price = Math.max(1, Math.min(maxAffordable, 1 + Math.floor(rand() * Math.min(maxAffordable, 60))));

    // Enter it through the real form, exactly as the operator would: type the
    // name, wait for the list, click the match.
    const picked = await browser.eval(`(() => {
      const i = document.getElementById('entry-player');
      i.focus(); i.value = ${JSON.stringify(player.n)};
      i.dispatchEvent(new Event('input', {bubbles:true}));
      // The autocomplete is debounced; wait for it rather than guessing.
      return new Promise(resolve => setTimeout(() => {
        const items = [...document.querySelectorAll('.ac__item')];
        const match = items.find(el => el.querySelector('.ac__name').textContent === ${JSON.stringify(player.n)});
        if (!match) return resolve('no-match:' + items.length);
        match.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
        resolve('ok');
      }, 140));
    })()`);
    if (picked !== 'ok') {
      skipped.push(`${player.n} (${picked})`);
      continue;
    }

    await browser.eval(`(() => {
      const t = document.getElementById('entry-team');
      t.value = ${JSON.stringify(team.id)};
      t.dispatchEvent(new Event('change', {bubbles:true}));
      const p = document.getElementById('entry-price');
      p.value = '${price}';
      p.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sleep(20);

    const added = await browser.eval(`(() => {
      const before = DraftApp.store.get().picks.length;
      const btn = [...document.querySelectorAll('.entry .btn')].find(b => /Add/.test(b.textContent));
      if (btn.disabled) return 'blocked';
      btn.click();
      return DraftApp.store.get().picks.length > before ? 'added' : 'rejected';
    })()`);

    if (added === 'added') {
      intended.push({
        playerId: player.id,
        playerName: player.n,
        teamName: team.name,
        price,
      });
      if (onPick) await onPick(intended.length, browser);
    } else {
      skipped.push(`${player.n} -> ${team.name} @ $${price} (${added})`);
    }
  }

  // A silently-skipped pick would make a "no data loss" result meaningless, so
  // surface them rather than quietly entering fewer picks.
  if (skipped.length) {
    console.log(`    (${skipped.length} attempts did not land, e.g. ${skipped.slice(0, 3).join('; ')})`);
  }
  runFullDraft.lastSkipped = skipped;

  return intended;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioStandaloneFile() {
  const name = 'A. Standalone file (file://, no server, no network)';
  console.log(`\n${name}`);
  const browser = new Browser();
  await browser.launch(9401);
  try {
    await browser.goto(`file://${join(ROOT, 'DraftBoard-offline.html')}`);
    await browser.waitFor('document.querySelectorAll(".team-row").length > 0', 'setup screen');
    await setupDraft(browser);
    const intended = await runFullDraft(browser, { seed: 11 });
    console.log(`    (entered ${intended.length} picks)`);
    await reconcile(name, browser, intended, null);
  } finally {
    await browser.close();
  }
}

async function scenarioLocalServerWithSheet() {
  const name = 'B. Local server (http://) + Google Sheet';
  console.log(`\n${name}`);
  await assertPortFree(8791, 'scenario B');
  const script = await startFakeAppsScript({ writeToken: '' });
  const app = startAppServer(8791);
  await waitForServer(8791, 'app server');

  const browser = new Browser();
  await browser.launch(9402);
  try {
    await browser.goto('http://localhost:8791/');
    await browser.waitFor('document.querySelectorAll(".team-row").length > 0', 'setup screen');
    await configureSheet(browser, script.url);
    await setupDraft(browser);

    const syncTrace = [];
    const intended = await runFullDraft(browser, {
      seed: 23,
      onPick: async (n, b) => {
        if (n % 20 === 0) {
          const snap = JSON.parse(await b.eval('JSON.stringify(DraftApp.sync.snapshot())'));
          const writes = script.requests.filter((op) => op === 'sync').length;
          syncTrace.push(`pick ${n}: status=${snap.status} dirty=${snap.dirty} writes=${writes}`);
        }
      },
    });
    console.log(`    (entered ${intended.length} picks)`);
    for (const line of syncTrace) console.log(`      ${line}`);

    await settleSync(browser);
    const writes = script.requests.filter((op) => op === 'sync').length;
    console.log(`    (sheet received ${writes} writes for ${intended.length} picks)`);
    await reconcile(name, browser, intended, appsScriptSheetView(script.spreadsheet));
    check(name, 'sync coalesced rather than writing once per pick',
      writes > 0 && writes < intended.length, `${writes} writes / ${intended.length} picks`);
  } finally {
    await browser.close();
    app.kill();
    await script.close();
  }
}

async function scenarioConnectionDropsMidDraft() {
  const name = 'C. Connection drops mid-draft, then returns';
  console.log(`\n${name}`);
  await assertPortFree(8792, 'scenario C');
  const script = await startFakeAppsScript({ writeToken: '' });
  const app = startAppServer(8792);
  await waitForServer(8792, 'app server');

  const browser = new Browser();
  await browser.launch(9403);
  try {
    await browser.goto('http://localhost:8792/');
    await browser.waitFor('document.querySelectorAll(".team-row").length > 0', 'setup screen');
    await configureSheet(browser, script.url);
    await setupDraft(browser);

    let droppedAt = null;
    const intended = await runFullDraft(browser, {
      seed: 31,
      onPick: async (n, b) => {
        // Kill the network a third of the way in, restore it two thirds in.
        if (n === Math.floor(TOTAL_PICKS / 3)) {
          droppedAt = n;
          script.setOffline(true);
          await b.setOffline(true);
        }
        if (n === Math.floor((TOTAL_PICKS * 2) / 3)) {
          script.setOffline(false);
          await b.setOffline(false);
        }
      },
    });
    console.log(`    (entered ${intended.length} picks; network was down from pick ${droppedAt})`);

    await settleSync(browser, 40);
    await reconcile(name, browser, intended, appsScriptSheetView(script.spreadsheet));
    check(name, 'picks entered during the outage survived',
      intended.length >= TOTAL_PICKS * 0.9, `only ${intended.length} picks`);
  } finally {
    await browser.close();
    app.kill();
    await script.close();
  }
}

async function scenarioCrashAndReload() {
  const name = 'D. Browser crash / reload mid-draft';
  console.log(`\n${name}`);
  const browser = new Browser();
  await browser.launch(9404);
  try {
    await browser.goto(`file://${join(ROOT, 'DraftBoard-offline.html')}`);
    await browser.waitFor('document.querySelectorAll(".team-row").length > 0', 'setup screen');
    await setupDraft(browser);

    const firstHalf = await runFullDraftPartial(browser, 40, 47);
    console.log(`    (entered ${firstHalf.length} picks, then reloading)`);

    // Hard reload, as if the browser had been force-quit.
    await browser.goto(`file://${join(ROOT, 'DraftBoard-offline.html')}`);
    await browser.waitFor('!!(window.DraftApp && DraftApp.store.exists())', 'draft to reload');

    const afterReload = await browser.eval('DraftApp.store.get().picks.length');
    check(name, 'every pick survived the reload', afterReload === firstHalf.length,
      `expected ${firstHalf.length}, got ${afterReload}`);
    check(name, 'resumed straight onto the board',
      (await browser.eval('document.body.dataset.screen')) === 'board');

    // Carry on and finish the draft.
    const rest = await runFullDraft(browser, { seed: 53 });
    const intended = firstHalf.concat(rest);
    console.log(`    (finished at ${intended.length} picks)`);
    await reconcile(name, browser, intended, null);
  } finally {
    await browser.close();
  }
}

/**
 * The combination only the Apps Script backend can do: the standalone HTML
 * file, opened straight off the disk with no server anywhere, still backing the
 * draft up to a spreadsheet. The browser talks to Google directly, so this is
 * also the only path where CORS is a real risk -- hence driving it through an
 * actual file:// page rather than testing the request shape in Node.
 */
async function scenarioStandaloneFileWithSheet() {
  const name = 'E. Standalone file (file://) + Google Sheet';
  console.log(`\n${name}`);
  const script = await startFakeAppsScript({ writeToken: 'sim-token' });

  const browser = new Browser();
  await browser.launch(9405);
  try {
    await browser.goto(`file://${join(ROOT, 'DraftBoard-offline.html')}`);
    await browser.waitFor('document.querySelectorAll(".team-row").length > 0', 'setup screen');

    await configureSheet(browser, script.url, 'sim-token');

    // Click the real button rather than calling sync.health(), so the wiring
    // between the form and the sync engine is part of what's being tested.
    await browser.eval(
      `[...document.querySelectorAll('.btn')].find(b => b.textContent === 'Test connection').click()`
    );
    await browser.waitFor(
      `!!document.querySelector('.note-slot .note') &&
       !/Testing/.test(document.querySelector('.note-slot .note').textContent)`,
      'the connection test to finish'
    );
    const healthNote = await browser.eval(`document.querySelector('.note-slot .note').textContent`);
    check(name, 'test connection reaches the script from file://',
      /Connected to/.test(healthNote), healthNote);

    await setupDraft(browser);
    const intended = await runFullDraft(browser, { seed: 71 });
    console.log(`    (entered ${intended.length} picks)`);

    await settleSync(browser);
    const syncs = script.requests.filter((op) => op === 'sync').length;
    console.log(`    (script received ${syncs} syncs for ${intended.length} picks)`);
    check(name, 'sync coalesced rather than writing once per pick',
      syncs > 0 && syncs < intended.length, `${syncs} syncs / ${intended.length} picks`);

    await reconcile(name, browser, intended, appsScriptSheetView(script.spreadsheet));
  } finally {
    await browser.close();
    await script.close();
  }
}

/**
 * Presents the fake spreadsheet the way reconcile() expects a sheet: a map of
 * A1 range -> rows, so the same assertions run against both backends.
 */
function appsScriptSheetView(spreadsheet) {
  const values = new Map();
  for (const [name, rows] of Object.entries(spreadsheet.dump())) {
    values.set(`'${name.replace(/'/g, "''")}'!A1`, rows);
  }
  return { values, writes: values.size };
}

/**
 * Two windows on one draft -- the failure the session lock exists to prevent.
 *
 * Both share localStorage, and on a full-snapshot model each would write its
 * own pick list over the other's, with the last writer silently winning. The
 * second window must therefore refuse to write at all, not merely show a
 * warning: a banner nobody reads is not a guard.
 */
async function scenarioTwoWindows() {
  const name = 'F. A second window cannot clobber the draft';
  console.log(`\n${name}`);
  await assertPortFree(8793, 'scenario F');
  const app = startAppServer(8793);
  await waitForServer(8793, 'app server');

  const browser = new Browser();
  await browser.launch(9406);
  let second = null;
  try {
    await browser.goto('http://localhost:8793/');
    await browser.waitFor('document.querySelectorAll(".team-row").length > 0', 'setup screen');
    await setupDraft(browser);

    const intended = await runFullDraftPartial(browser, 30, 61);
    console.log(`    (first window entered ${intended.length} picks)`);

    // Open a second tab on the same origin: same localStorage, same draft.
    second = await browser.openSecondTab('http://localhost:8793/');
    await second.waitFor('!!(window.DraftApp && DraftApp.store.exists())', 'the second window');

    check(name, 'the second window knows it is a mirror',
      (await second.eval('DraftApp.store.isReadOnly()')) === true);
    check(name, 'and says so on screen',
      /already open in another window/i.test(await second.eval('document.body.innerText')));

    // Try every write path from the mirror.
    const before = await browser.eval('DraftApp.store.get().picks.length');
    const blocked = JSON.parse(await second.eval(`(() => {
      const s = DraftApp.store;
      const first = s.get().picks[0];
      return JSON.stringify({
        add: s.addPick({ playerId: 'zz', playerName: 'Intruder', position: 'QB',
                         teamId: s.get().teams[0].id, price: 1, slot: 'QB' }),
        edit: s.updatePick(first.id, { price: 999 }),
        remove: s.removePick(first.id),
        undo: s.undoLast(),
        count: s.get().picks.length
      });
    })()`));
    check(name, 'every write from the mirror is refused',
      blocked.add === null && blocked.edit === null && blocked.remove === null && blocked.undo === null,
      JSON.stringify(blocked));
    check(name, 'the mirror did not change its own copy either',
      blocked.count === before, `${blocked.count} vs ${before}`);

    // The real window keeps working, and its picks survive the mirror's attempts.
    const more = await runFullDraft(browser, { seed: 67 });
    const all = intended.concat(more);
    console.log(`    (first window finished at ${all.length} picks)`);

    const stored = JSON.parse(
      await browser.eval(`JSON.stringify(JSON.parse(localStorage.getItem('sleeperDraftTracker.state.v1')).picks.map(p => p.playerName))`)
    );
    check(name, 'localStorage holds the real window’s draft, not the mirror’s',
      stored.length === all.length && !stored.includes('Intruder'),
      `${stored.length} stored vs ${all.length} entered`);

    await reconcile(name, browser, all, null);
  } finally {
    if (second) await second.close();
    await browser.close();
    app.kill();
  }
}

/** Same as runFullDraft but stops after `limit` picks. */
async function runFullDraftPartial(browser, limit, seed) {
  const all = [];
  const stop = { hit: false };
  const picks = await runFullDraft(browser, {
    seed,
    onPick: async (n) => {
      if (n >= limit && !stop.hit) {
        stop.hit = true;
        throw new Error('__STOP__');
      }
    },
  }).catch((err) => {
    if (!String(err.message).includes('__STOP__')) throw err;
    return null;
  });
  if (picks) all.push(...picks);
  else {
    // Recover what actually landed.
    const live = JSON.parse(
      await browser.eval(`(() => {
        const s = DraftApp.store.get();
        return JSON.stringify(s.picks.map(p => ({
          playerId: p.playerId, playerName: p.playerName, price: p.price,
          teamName: (DraftApp.store.teamById(p.teamId)||{}).name
        })));
      })()`)
    );
    all.push(...live);
  }
  return all;
}

// ---------------------------------------------------------------------------

/**
 * Kills browsers left behind by a crashed run. Scoped to this harness's own
 * temp profiles so it can't touch the user's real Chrome.
 */
function killStaleBrowsers() {
  try {
    spawn('pkill', ['-f', 'user-data-dir=' + join(tmpdir(), 'sim-chrome-')], { stdio: 'ignore' });
  } catch {
    /* nothing to clean up */
  }
}

/** Also sweep app servers this harness spawned, for the same reason. */
function killStaleServers() {
  try {
    spawn('pkill', ['-f', 'SIM_APP_SERVER'], { stdio: 'ignore' });
  } catch {
    /* nothing to clean up */
  }
}

async function main() {
  killStaleBrowsers();
  killStaleServers();
  await sleep(500);

  const only = process.argv[2];
  const scenarios = {
    a: scenarioStandaloneFile,
    b: scenarioLocalServerWithSheet,
    c: scenarioConnectionDropsMidDraft,
    d: scenarioCrashAndReload,
    e: scenarioStandaloneFileWithSheet,
    f: scenarioTwoWindows,
  };

  console.log(`Full-draft simulations — ${TEAMS.length} teams × ${SPOTS_PER_TEAM} spots = ${TOTAL_PICKS} picks each`);

  const toRun = only ? [scenarios[only.toLowerCase()]].filter(Boolean) : Object.values(scenarios);
  if (!toRun.length) throw new Error(`Unknown scenario "${only}" (use a, b, c, d, e or f)`);

  for (const scenario of toRun) await scenario();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${totalPass} passed, ${totalFail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('');
  process.exit(totalFail ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nHarness error: ${err.stack}`);
  process.exit(1);
});
