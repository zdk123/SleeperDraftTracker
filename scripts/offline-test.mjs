#!/usr/bin/env node
// Loads DraftBoard-offline.html over file:// in headless Chrome -- no server
// running at all -- and runs a draft through it. This is the configuration the
// operator falls back to if the venue has no wifi and no Node, so it needs to
// be proven, not assumed. Also asserts that the failed /api call degrades
// quietly instead of throwing.
//
// Run with: node --experimental-websocket scripts/offline-test.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_URL = `file://${join(ROOT, 'DraftBoard-offline.html')}`;
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let nextId = 1;
let ws;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
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

async function main() {
  try {
    await access(join(ROOT, 'DraftBoard-offline.html'));
  } catch {
    throw new Error('DraftBoard-offline.html missing — run node scripts/build-offline.mjs first');
  }

  const profile = await mkdtemp(join(tmpdir(), 'offline-chrome-'));
  const port = 9355;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1600,1000',
      // Allow file:// access the way a double-clicked file gets it.
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    let wsUrl;
    for (let i = 0; i < 50; i += 1) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find((t) => t.type === 'page');
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* still starting */
      }
      await sleep(200);
    }

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

    await send('Runtime.enable');
    await send('Page.enable');

    console.log(`\nLoading over file:// (no server running)`);
    await send('Page.navigate', { url: FILE_URL });
    await sleep(1500);

    check('page is genuinely on the file:// scheme', (await evaluate('location.protocol')) === 'file:');
    check('app booted', (await evaluate('typeof window.DraftApp')) === 'object');
    check('styles were inlined (no external CSS fetch)', (await evaluate(`
      getComputedStyle(document.querySelector('.topbar')).display
    `)) === 'flex');
    const count = await evaluate('window.DraftApp.players.count()');
    check('player list came from the inlined copy', count > 500, `count=${count}`);
    check('setup screen rendered', (await evaluate('document.querySelectorAll(".team-row").length')) > 0);

    console.log('\nRunning a draft with no server');
    await evaluate(`(() => {
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
      const rows = () => [...document.querySelectorAll('.team-row')];
      while (rows().length > 3) rows()[rows().length-1].querySelector('.btn--icon').click();
      const ins = [...document.querySelectorAll('.team-row input')];
      set(ins[0], 'Alpha'); set(ins[2], 'Bravo'); set(ins[4], 'Charlie');
      set(document.getElementById('budget'), '100');
      const slotInputs = [...document.querySelectorAll('.slot-row input')];
      slotInputs.forEach(i => set(i, '0'));
      set(slotInputs[0], '1'); set(slotInputs[1], '1');
    })()`);
    await sleep(200);
    await evaluate(`[...document.querySelectorAll('.btn')].find(b => b.textContent === 'Start draft').click()`);
    await sleep(400);
    check('draft started', (await evaluate('document.body.dataset.screen')) === 'board');

    await evaluate(`(() => {
      const i = document.getElementById('entry-player');
      i.focus(); i.value = 'josh allen';
      i.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sleep(250);
    check('autocomplete works offline', (await evaluate('document.querySelectorAll(".ac__item").length')) > 0);
    await evaluate(`document.querySelector('.ac__item').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
    await sleep(150);
    await evaluate(`(() => {
      const p = document.getElementById('entry-price');
      p.value = '40'; p.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sleep(100);
    await evaluate(`[...document.querySelectorAll('.entry .btn')].find(b => /Add/.test(b.textContent)).click()`);
    await sleep(300);

    check('pick recorded', (await evaluate('DraftApp.store.get().picks.length')) === 1);
    check(
      'price renders with a dollar sign (the $$ bundling hazard)',
      /^\$\d+$/.test(await evaluate(`document.querySelector('.team-col__left').textContent`)),
      await evaluate(`document.querySelector('.team-col__left').textContent`)
    );
    check(
      'board shows the pick',
      await evaluate(`[...document.querySelectorAll('.pick__player')].some(e => /Allen/.test(e.textContent))`)
    );
    check(
      'money formatting in the pick row is intact',
      await evaluate(`/\\$40/.test(document.querySelector('.pick__price').textContent)`)
    );

    console.log('\nDegradation with no backend reachable');
    await evaluate(`DraftApp.sync.flushNow('offline test')`);
    await sleep(1200);
    const snap = await evaluate('JSON.stringify(DraftApp.sync.snapshot())');
    check(
      'sync reports offline/local rather than crashing',
      /offline|disabled|error/.test(snap),
      snap
    );
    check('status pill still rendered', await evaluate(`!!document.querySelector('.syncpill')`));
    check(
      'the draft is unaffected by the failed sync',
      (await evaluate('DraftApp.store.get().picks.length')) === 1
    );

    console.log('\nPersistence on file://');
    const stored = await evaluate(
      `(() => { try { return JSON.parse(localStorage.getItem('sleeperDraftTracker.state.v1')).picks.length; } catch { return -1; } })()`
    );
    check('localStorage works from file://', stored === 1, `got ${stored}`);
    await send('Page.navigate', { url: FILE_URL });
    await sleep(1500);
    check('draft resumes after reload', (await evaluate('DraftApp.store.get().picks.length')) === 1);

    console.log('\nExport (the path that matters most offline)');
    const text = await evaluate('DraftApp.exporter.rostersText()');
    check('roster export produced', /Alpha/.test(text) && /Allen/.test(text), text.slice(0, 160));
    check('export shows the price with a dollar sign', /\$40/.test(text));

    console.log('\nConsole health');
    // A failed fetch to a file:// relative /api path logs a network error in
    // some builds; only unhandled exceptions are a real problem.
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n       '));
    if (consoleErrors.length) {
      console.log(`  note  ${consoleErrors.length} console error(s), expected for the blocked /api call:`);
      for (const err of consoleErrors.slice(0, 3)) console.log(`        ${err.slice(0, 120)}`);
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
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
