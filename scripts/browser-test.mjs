#!/usr/bin/env node
// Drives the real app in headless Chrome over the DevTools protocol: runs a
// mock draft through the actual UI, checks the board reflects it, and fails on
// any console error. No dependencies -- Node's WebSocket plus Chrome.
//
// Run with: node --experimental-websocket scripts/browser-test.mjs
// (Assumes the local server is already running on PORT, default 8787.)

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT || 8787;
const URL_BASE = `http://localhost:${PORT}/`;
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let nextId = 1;
let ws;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 20000);
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `page threw: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`
    );
  }
  return res.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(
        msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text
      );
    }
  });
}

async function findTarget(port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await sleep(200);
  }
  throw new Error('Chrome never exposed a debuggable page');
}

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

/**
 * Fail loudly if nobody is serving the app. Without this the first evaluate()
 * dies on `window.DraftApp` being undefined, which reads like an app bug.
 */
async function assertServerUp() {
  try {
    const res = await fetch(URL_BASE, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `Nothing is serving ${URL_BASE} (${err.message}).\n` +
        `       Start it first:  node server.js`
    );
  }
}

async function main() {
  await assertServerUp();
  const profile = await mkdtemp(join(tmpdir(), 'draft-chrome-'));
  const debugPort = 9333;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    await connect(await findTarget(debugPort));
    await send('Runtime.enable');
    await send('Page.enable');

    await send('Page.navigate', { url: URL_BASE });
    await sleep(1500);

    console.log('\nBoot');
    check('app namespace loaded', (await evaluate('typeof window.DraftApp')) === 'object');
    check('player list loaded', (await evaluate('window.DraftApp.players.count()')) > 500);
    check(
      'setup screen is showing',
      (await evaluate('document.body.dataset.screen')) === 'setup'
    );
    check(
      'theme applied',
      ['light', 'dark'].includes(await evaluate('document.documentElement.dataset.theme'))
    );

    console.log('\nSetup');
    // Configure a small league: 3 teams, $100, 3 slots each.
    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('.team-row input')];
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
      set(inputs[0], 'Sharks'); set(inputs[2], 'Bears'); set(inputs[4], 'Wolves');
      // remove teams 4..12
      const removeBtns = () => [...document.querySelectorAll('.team-row .btn--icon')];
      while (document.querySelectorAll('.team-row').length > 3) {
        removeBtns()[document.querySelectorAll('.team-row').length - 1].click();
      }
      set(document.getElementById('budget'), '100');
      // zero out all roster slots, then set QB=1, RB=1, FLEX=1
      const slotInputs = [...document.querySelectorAll('.slot-row input')];
      slotInputs.forEach(i => set(i, '0'));
      set(slotInputs[0], '1'); // QB
      set(slotInputs[1], '1'); // RB
      set(slotInputs[4], '1'); // FLEX
    })()`);
    await sleep(200);

    check('three teams configured', (await evaluate('document.querySelectorAll(".team-row").length')) === 3);

    await evaluate(`[...document.querySelectorAll('.btn')].find(b => b.textContent === 'Start draft').click()`);
    await sleep(400);

    check('board screen is showing', (await evaluate('document.body.dataset.screen')) === 'board');
    check('three team columns rendered', (await evaluate('document.querySelectorAll(".team-col").length')) === 3);
    check(
      'budget shows $100',
      (await evaluate('document.querySelector(".team-col__left").textContent')) === '$100'
    );

    console.log('\nAutocomplete');
    await evaluate(`(() => {
      const i = document.getElementById('entry-player');
      i.focus(); i.value = 'mahomes';
      i.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sleep(250);
    const acCount = await evaluate('document.querySelectorAll(".ac__item").length');
    check('autocomplete returns matches', acCount > 0, `got ${acCount}`);
    const firstName = await evaluate('document.querySelector(".ac__name")?.textContent');
    check('top match is the right player', /mahomes/i.test(firstName || ''), `got "${firstName}"`);

    console.log('\nEntering picks');
    // Helper that mirrors what the operator does: pick from the list, type a price, Enter.
    const addPick = async (query, teamIndex, price) => {
      await evaluate(`(() => {
        const i = document.getElementById('entry-player');
        i.focus(); i.value = ${JSON.stringify(query)};
        i.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
      await sleep(150);
      await evaluate(`document.querySelector('.ac__item').dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`);
      await sleep(100);
      await evaluate(`(() => {
        const t = document.getElementById('entry-team');
        t.selectedIndex = ${teamIndex};
        t.dispatchEvent(new Event('change', {bubbles:true}));
        const p = document.getElementById('entry-price');
        p.value = '${price}';
        p.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
      await sleep(100);
      await evaluate(`[...document.querySelectorAll('.entry .btn')].find(b => /Add/.test(b.textContent)).click()`);
      await sleep(200);
    };

    await addPick('mahomes', 0, 40);
    check('pick recorded in state', (await evaluate('DraftApp.store.get().picks.length')) === 1);
    check(
      'board shows the player',
      await evaluate(`[...document.querySelectorAll('.pick__player')].some(e => /Mahomes/.test(e.textContent))`)
    );
    check(
      'budget decreased to $60',
      (await evaluate('document.querySelector(".team-col__left").textContent')) === '$60'
    );
    check(
      'recent strip shows the pick',
      await evaluate(`/Mahomes/.test(document.querySelector('.recent')?.textContent || '')`)
    );
    check(
      'entry form cleared for the next pick',
      (await evaluate('document.getElementById("entry-player").value')) === ''
    );

    await addPick('bijan robinson', 1, 55);
    await addPick('ja\'marr chase', 2, 50);
    check('three picks recorded', (await evaluate('DraftApp.store.get().picks.length')) === 3);

    console.log('\nNomination order');
    check(
      'board names who is nominating',
      await evaluate(`!!document.querySelector('.summary__nominating')`)
    );
    check(
      'exactly one team column is flagged',
      (await evaluate('document.querySelectorAll(".team-col.is-nominating").length')) === 1
    );
    const nominatorMatches = await evaluate(`(() => {
      const id = DraftApp.store.currentNominator();
      const name = DraftApp.store.teamById(id).name;
      return document.querySelector('.summary__team').textContent === name;
    })()`);
    check('the named nominator matches the computed one', nominatorMatches);

    console.log('\nGuardrails');
    // Sharks: $100 budget, spent $40, 2 slots open -> max bid = 60 - 1 = 59.
    const overBudget = await evaluate(`(() => {
      const r = DraftApp.validation.check({
        teamId: DraftApp.store.get().teams[0].id,
        playerId: 'zzz', playerName: 'Expensive Guy', position: 'RB', price: 60
      });
      return JSON.stringify(r.blockers.map(b => b.code));
    })()`);
    check('over-budget bid is blocked', overBudget.includes('over_budget'), overBudget);

    const submitDisabled = await evaluate(`(() => {
      const t = document.getElementById('entry-team');
      t.selectedIndex = 0; t.dispatchEvent(new Event('change', {bubbles:true}));
      const i = document.getElementById('entry-player');
      i.value = 'saquon'; i.dispatchEvent(new Event('input', {bubbles:true}));
      return new Promise(r => setTimeout(() => {
        document.querySelector('.ac__item').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
        setTimeout(() => {
          const p = document.getElementById('entry-price');
          p.value = '999'; p.dispatchEvent(new Event('input', {bubbles:true}));
          setTimeout(() => r([...document.querySelectorAll('.entry .btn')].find(b=>/Add/.test(b.textContent)).disabled), 150);
        }, 150);
      }, 200));
    })()`);
    check('an unaffordable bid disables the Add button outright', submitDisabled === true, `disabled=${submitDisabled}`);
    await evaluate(`(() => {
      const i=document.getElementById('entry-player'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
      const p=document.getElementById('entry-price'); p.value=''; p.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);

    const dupCheck = await evaluate(`(() => {
      const picks = DraftApp.store.get().picks;
      const r = DraftApp.validation.check({
        teamId: DraftApp.store.get().teams[1].id,
        playerId: picks[0].playerId, playerName: picks[0].playerName, position: 'QB', price: 5
      });
      return JSON.stringify({codes: r.blockers.map(b=>b.code), canOverride: r.canOverride});
    })()`);
    check('duplicate is blocked and not overridable', dupCheck.includes('duplicate') && dupCheck.includes('"canOverride":false'), dupCheck);

    const draftedFlag = await evaluate(`(() => {
      const i = document.getElementById('entry-player');
      i.focus(); i.value = 'mahomes';
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return new Promise(r => setTimeout(() => r(document.querySelectorAll('.ac__item.is-drafted').length), 200));
    })()`);
    check('already-drafted players are flagged in autocomplete', draftedFlag > 0, `got ${draftedFlag}`);
    await evaluate(`(() => { const i=document.getElementById('entry-player'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);

    console.log('\nUndo and persistence');
    await evaluate(`DraftApp.store.undoLast()`);
    await sleep(150);
    check('undo removed the pick', (await evaluate('DraftApp.store.get().picks.length')) === 2);
    check(
      'undo restored the budget on the board',
      await evaluate(`[...document.querySelectorAll('.team-col__left')].map(e=>e.textContent).includes('$100')`)
    );

    const savedCount = await evaluate(
      `JSON.parse(localStorage.getItem('sleeperDraftTracker.state.v1')).picks.length`
    );
    check('state persisted to localStorage', savedCount === 2, `got ${savedCount}`);

    // Reload and confirm the draft comes back.
    await send('Page.navigate', { url: URL_BASE });
    await sleep(1500);
    check('draft resumed after reload', (await evaluate('DraftApp.store.get().picks.length')) === 2);
    check('resumed onto the board screen', (await evaluate('document.body.dataset.screen')) === 'board');
    check(
      'resume banner shown',
      await evaluate(`/Resumed/.test(document.getElementById('banners').textContent)`)
    );

    console.log('\nExport');
    const rosterText = await evaluate('DraftApp.exporter.rostersText()');
    check('roster export lists teams', /Sharks/.test(rosterText) && /Bears/.test(rosterText));
    check('roster export shows prices', /\$55/.test(rosterText), rosterText.slice(0, 200));
    const csv = await evaluate('DraftApp.exporter.picksCsv()');
    check('pick CSV has a header and rows', csv.split('\r\n').length >= 3);

    console.log('\nTheme');
    await evaluate(`document.getElementById('theme-toggle').click()`);
    await sleep(100);
    const theme1 = await evaluate('document.documentElement.dataset.theme');
    await evaluate(`document.getElementById('theme-toggle').click()`);
    await sleep(100);
    const theme2 = await evaluate('document.documentElement.dataset.theme');
    check('theme toggles between light and dark', theme1 !== theme2, `${theme1} -> ${theme2}`);
    check(
      'theme choice persists',
      (await evaluate(`JSON.parse(localStorage.getItem('sleeperDraftTracker.prefs.v1')).theme`)) === theme2
    );

    console.log('\nSync status (no credentials configured)');
    await evaluate(`DraftApp.sync.flushNow('test')`);
    await sleep(800);
    const syncStatus = await evaluate('JSON.stringify(DraftApp.sync.snapshot())');
    check(
      'sync degrades to local-only rather than erroring',
      syncStatus.includes('disabled') || syncStatus.includes('local'),
      syncStatus
    );
    check(
      'status pill is visible',
      await evaluate(`!!document.querySelector('.syncpill')`)
    );

    console.log('\nPanels');
    for (const [label, expect] of [
      ['Picks', '.hist__row'],
      ['Export', '.copybox'],
      ['Backup', '.btn-stack'],
    ]) {
      await evaluate(`[...document.querySelectorAll('#topbar-actions .btn')].find(b => b.textContent === '${label}').click()`);
      await sleep(200);
      check(`${label} panel renders`, await evaluate(`!!document.querySelector('${expect}')`));
      await evaluate(`document.getElementById('panel-close').click()`);
      await sleep(100);
    }

    // Share is the one panel whose answer depends on where the app is served
    // from. On localhost a link would point at each guest's own phone, so it
    // must say so rather than hand over something that fails in their hands.
    await evaluate(`[...document.querySelectorAll('#topbar-actions .btn')].find(b => b.textContent === 'Share').click()`);
    await sleep(200);
    const shareText = await evaluate(`document.getElementById('panel-body').innerText`);
    check(
      'Share panel refuses to hand out a localhost link',
      /Not from this address/i.test(shareText) && !/view\.html#/.test(shareText),
      shareText.slice(0, 120)
    );
    await evaluate(`document.getElementById('panel-close').click()`);
    await sleep(100);

    // A setup link fills in the spreadsheet settings so the operator types
    // nothing on the night -- and then has to disappear, because it carries the
    // write token and the screen is being mirrored to a television.
    console.log('\nSetup link');
    {
      const link = await evaluate(`DraftApp.shareLink.encodeSetup({
        scriptUrl: 'https://script.google.com/macros/s/AKfyTESTID/exec',
        token: 'write-tok-abc',
        viewToken: 'view-tok-xyz',
      })`);
      // Clear the saved draft first: the case that matters is a fresh laptop
      // landing on the setup screen, where the form should come up filled in.
      // With a draft in localStorage the app resumes onto the board instead and
      // there is no form to check.
      await evaluate(`localStorage.clear()`);
      // A fragment-only change does not reload, so start from a blank page to
      // test the cold-open path honestly.
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(300);
      await send('Page.navigate', { url: `${URL_BASE}${link}` });
      await sleep(1500);
      check('a setup link lands on the setup screen',
        (await evaluate('document.body.dataset.screen')) === 'setup');

      const applied = JSON.parse(await evaluate(`JSON.stringify({
        url: DraftApp.persistence.prefs().appsScriptUrl,
        token: DraftApp.persistence.prefs().token,
        viewToken: DraftApp.persistence.prefs().viewToken,
        hash: location.hash,
        href: location.href,
        field: (document.getElementById('apps-script-url') || {}).value,
        tokenField: (document.getElementById('token') || {}).value,
      })`));

      check('setup link fills the web app URL',
        applied.url === 'https://script.google.com/macros/s/AKfyTESTID/exec', applied.url);
      check('setup link fills both tokens',
        applied.token === 'write-tok-abc' && applied.viewToken === 'view-tok-xyz',
        `${applied.token} / ${applied.viewToken}`);
      check('the form shows the values, not just storage',
        applied.field === 'https://script.google.com/macros/s/AKfyTESTID/exec' &&
          applied.tokenField === 'write-tok-abc',
        `${applied.field} / ${applied.tokenField}`);
      check('the write token is wiped from the address bar',
        applied.hash === '' && !applied.href.includes('write-tok-abc'), applied.href);
      check('the operator is told what happened',
        /settings loaded from your link/i.test(await evaluate('document.body.innerText')));

      // The realistic case: the app is already open and he clicks the link,
      // so the browser focuses this tab and only the fragment changes.
      const second = await evaluate(`DraftApp.shareLink.encodeSetup({
        scriptUrl: 'https://script.google.com/macros/s/AKfySECOND/exec',
        token: 'write-tok-2',
        viewToken: 'view-tok-2',
      })`);
      await evaluate(`location.hash = ${JSON.stringify(second.slice(1))}`);
      await sleep(600);

      const updated = JSON.parse(await evaluate(`JSON.stringify({
        url: DraftApp.persistence.prefs().appsScriptUrl,
        token: DraftApp.persistence.prefs().token,
        hash: location.hash,
        field: (document.getElementById('apps-script-url') || {}).value,
      })`));
      check('a setup link applies even when the app is already open',
        updated.url === 'https://script.google.com/macros/s/AKfySECOND/exec' &&
          updated.token === 'write-tok-2',
        `${updated.url} / ${updated.token}`);
      check('the form is redrawn with the new values',
        updated.field === 'https://script.google.com/macros/s/AKfySECOND/exec', updated.field);
      check('and that fragment is wiped too', updated.hash === '', updated.hash);
    }

    // The guests' link pasted into the operator's app: send them where they
    // meant to go rather than silently ignoring it.
    {
      const viewer = await evaluate(
        `DraftApp.shareLink.encode({ url: 'https://script.google.com/macros/s/AKfyTESTID/exec', token: 'v', draftKey: 'k' })`
      );
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(300);
      await send('Page.navigate', { url: `${URL_BASE}${viewer}` });
      await sleep(1500);
      check('a viewer link opened on the operator page redirects to the viewer',
        /view\.html/.test(await evaluate('location.pathname + location.hash')),
        await evaluate('location.pathname'));
      await send('Page.navigate', { url: URL_BASE });
      await sleep(1200);
    }

    console.log('\nConsole health');
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n       '));
    check('no console errors', consoleErrors.length === 0, consoleErrors.join('\n       '));
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
    // Chrome flushes its profile asynchronously; retry so cleanup doesn't race it.
    for (let i = 0; i < 5; i += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nHarness error: ${err.stack}`);
  process.exit(1);
});
