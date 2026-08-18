#!/usr/bin/env node
// Covers the read-only viewer: public/js/viewer.js and public/js/shareLink.js.
//
// The poll loop is driven through tick() rather than through its timers. That
// is not a shortcut -- browser-modules.mjs stubs setInterval to a no-op, and a
// suite that genuinely sat through 8-second polls and 60-second backoffs could
// not live in `npm test`. It is also why sync.js's own timing logic has no fast
// coverage today, a gap worth not repeating.
//
// Run with: node scripts/test-viewer.mjs

import assert from 'node:assert/strict';
import { loadBrowserModules } from './browser-modules.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const VIEWER_FILES = [
  'utils.js',
  'schema.js',
  'state.js',
  'persistence.js',
  'shareLink.js',
  'sheetBackend.js',
  'viewer.js',
];

function draftState({ revision = 1, picks = 2 } = {}) {
  return {
    version: 1,
    draftId: 'd-alpha',
    draftKey: '2026-08-24 Test x1y2',
    name: 'Test',
    revision,
    status: 'drafting',
    updatedAt: '2026-08-24T18:00:00.000Z',
    settings: {
      budgetPerTeam: 200,
      minBid: 1,
      nominationStyle: 'rotating',
      rosterSlots: [
        { slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] },
        { slotKey: 'RB', label: 'RB', count: 2, eligiblePositions: ['RB'] },
      ],
    },
    nominationOrder: ['t1', 't2'],
    teams: [
      { id: 't1', name: 'Team One' },
      { id: 't2', name: 'Team Two' },
    ],
    picks: Array.from({ length: picks }, (_, i) => ({
      id: `p${i}`,
      playerId: `x${i}`,
      playerName: `Player ${i}`,
      position: 'RB',
      teamId: i % 2 ? 't2' : 't1',
      price: 10,
      slot: i % 2 ? 'RB1' : 'QB',
    })),
  };
}

/**
 * A viewer wired to a scripted backend. `sheet` is mutable, so a test can move
 * the draft on and watch what the viewer does about it.
 */
function harness({ sheet = draftState(), drafts = [], fail = null } = {}) {
  const App = loadBrowserModules(VIEWER_FILES);
  const calls = [];
  const sleeps = [];

  App.backend = {
    setUrl() {},
    setToken() {},
    async poll(draftKey) {
      calls.push({ op: 'poll', draftKey });
      if (fail && fail()) throw Object.assign(new Error('network down'), { code: 'unreachable' });
      if (!sheet) return { status: 200, data: { ok: true, found: false } };
      return {
        status: 200,
        data: { ok: true, found: true, revision: sheet.revision, draftId: sheet.draftId },
      };
    },
    async load(draftKey) {
      calls.push({ op: 'load', draftKey });
      if (fail && fail()) throw Object.assign(new Error('network down'), { code: 'unreachable' });
      if (!sheet) return { status: 200, data: { ok: true, found: false, state: null } };
      return { status: 200, data: { ok: true, found: true, state: JSON.parse(JSON.stringify(sheet)) } };
    },
    async list() {
      calls.push({ op: 'list' });
      return { status: 200, data: { ok: true, drafts } };
    },
  };

  let clock = 1_000_000;
  App.viewer.inject({
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
    hidden: () => false,
  });

  return {
    App,
    calls,
    sleeps,
    ops: () => calls.map((c) => c.op),
    advance: (ms) => { clock += ms; },
    setSheet: (next) => { sheet = next; },
  };
}

console.log('\nAsking cheaply, fetching rarely');

await test('the first tick loads, because nothing is known yet', async () => {
  const h = harness();
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  const res = await h.App.viewer.tick();
  assert.equal(res.action, 'first-load');
  assert.deepEqual(h.ops(), ['load'], 'no point polling before anything is loaded');
  assert.equal(h.App.store.get().picks.length, 2);
});

await test('an unchanged revision does NOT fetch the draft again', async () => {
  // The cost assumption the whole design rests on. If this ever regresses,
  // every phone starts pulling tens of kilobytes every few seconds.
  const h = harness();
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h.App.viewer.tick();

  for (let i = 0; i < 10; i += 1) assert.equal((await h.App.viewer.tick()).action, 'unchanged');

  assert.deepEqual(
    h.ops(),
    ['load', ...Array(10).fill('poll')],
    'ten idle ticks must cost ten cheap polls and not one load'
  );
});

await test('a changed revision fetches exactly once', async () => {
  const h = harness();
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h.App.viewer.tick();

  h.setSheet(draftState({ revision: 2, picks: 4 }));
  assert.equal((await h.App.viewer.tick()).action, 'loaded');
  assert.equal(h.App.store.get().picks.length, 4, 'the new picks should be on screen');

  assert.equal((await h.App.viewer.tick()).action, 'unchanged', 'and it settles again');
  assert.equal(h.calls.filter((c) => c.op === 'load').length, 2);
});

await test('the load is spread out, so a dozen phones do not all fetch at once', async () => {
  // Jittering the poll spreads *detection*; every phone still detects the same
  // revision bump. Only jittering the load spreads the load.
  const delays = new Set();
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const h = harness();
    h.App.viewer.inject({ random: () => r });
    h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
    await h.App.viewer.tick();
    h.setSheet(draftState({ revision: 2 }));
    await h.App.viewer.tick();
    assert.equal(h.sleeps.length, 1, 'a load should wait before firing');
    delays.add(h.sleeps[0]);
  }
  assert.ok(delays.size >= 4, `expected a spread of delays, got ${[...delays].join(', ')}`);
  assert.ok(Math.max(...delays) <= 3000, 'but never a delay long enough to feel broken');
});

console.log('\nWhen the sheet cannot be reached');

await test('a failure backs off and does not lose the draft already on screen', async () => {
  let broken = false;
  const h = harness({ fail: () => broken });
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h.App.viewer.tick();

  broken = true;
  assert.equal((await h.App.viewer.tick()).action, 'error');
  assert.equal(h.App.store.get().picks.length, 2, 'the last good draft must stay on screen');
  assert.equal(h.App.viewer.snapshot().phase, 'error');

  broken = false;
  assert.equal((await h.App.viewer.tick()).action, 'unchanged');
  assert.equal(h.App.viewer.snapshot().phase, 'live', 'and it recovers on its own');
});

await test('one dropped poll does not make a fresh screen claim to be stale', async () => {
  // On venue cellular a single failed request is routine. Flashing a warning
  // while the data is seconds old just teaches people to ignore the warning.
  let broken = false;
  const h = harness({ fail: () => broken });
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h.App.viewer.tick();

  h.advance(3000);
  broken = true;
  await h.App.viewer.tick();

  assert.equal(h.App.viewer.freshness().level, 'fresh', 'three seconds old is fresh, error or not');
});

await test('sustained failure does turn the screen stale, then dead', async () => {
  const h = harness({ fail: () => true });
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  h.App.viewer.inject({ now: () => 1_000_000 });
  assert.equal(h.App.viewer.freshness().level, 'unknown', 'nothing loaded yet is not "fresh"');

  const h2 = harness();
  h2.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h2.App.viewer.tick();
  h2.advance(50_000);
  assert.equal(h2.App.viewer.freshness().level, 'stale');
  h2.advance(100_000);
  assert.equal(h2.App.viewer.freshness().level, 'dead');
});

console.log('\nWhen the pinned draft is gone');

await test('a missing draft is reported, not silently swapped', async () => {
  const h = harness({
    sheet: null,
    drafts: [
      { draftKey: 'old one', name: 'Last year', updated: '2025-08-24T10:00:00.000Z' },
      { draftKey: 'new one', name: 'Tonight', updated: '2026-08-24T19:00:00.000Z' },
    ],
  });
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: 'vanished' });

  let announced = null;
  h.App.bus.on('viewer:gone', (info) => { announced = info; });
  const res = await h.App.viewer.tick();

  assert.equal(res.action, 'gone');
  assert.equal(res.suggestion.draftKey, 'new one', 'the newest draft is the sensible offer');
  assert.equal(announced.suggestion.name, 'Tonight', 'and it must be named, not just opened');
  assert.ok(h.ops().includes('list'), 'finding the alternative means asking for the list');
});

await test('no alternative to offer is still a clean answer', async () => {
  const h = harness({ sheet: null, drafts: [] });
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: 'vanished' });
  const res = await h.App.viewer.tick();
  assert.equal(res.action, 'gone');
  assert.equal(res.suggestion, null);
});

console.log('\nThe viewer cannot write');

await test('every mutation is refused', async () => {
  const h = harness();
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h.App.viewer.tick();
  h.App.store.setReadOnly(true);

  const before = JSON.stringify(h.App.store.get());
  assert.equal(h.App.store.addPick({ playerName: 'X', teamId: 't1', price: 5 }), null);
  assert.equal(h.App.store.updatePick('p0', { price: 999 }), null);
  assert.equal(h.App.store.removePick('p0'), null);
  assert.equal(h.App.store.undoLast(), null);
  assert.equal(JSON.stringify(h.App.store.get()), before, 'nothing may have changed');
});

await test('the viewer never writes the operator’s saved draft', async () => {
  // Both pages share an origin, so the operator opening the viewer on their own
  // laptop must not let it stamp on the draft they are running.
  const h = harness();
  h.App.viewer.connect({ url: 'https://script/exec', token: 'guest', draftKey: '2026-08-24 Test x1y2' });
  await h.App.viewer.tick();
  h.setSheet(draftState({ revision: 2, picks: 4 }));
  await h.App.viewer.tick();

  assert.equal(
    h.App.persistence.load(),
    null,
    'sleeperDraftTracker.state.v1 must be untouched by a full poll cycle'
  );
});

await test('the viewer page loads no code that can write', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(join(ROOT, 'public', 'view.html'), 'utf8');

  for (const forbidden of ['js/sync.js', 'js/views/entry.js', 'js/views/setup.js', 'js/views/history.js']) {
    assert.ok(!html.includes(forbidden), `view.html must not load ${forbidden}`);
  }
  assert.ok(!/sw\.js/.test(html), 'the viewer deliberately registers no service worker');
  assert.ok(!html.includes('data/players.json'), 'a guest’s phone has no use for the player list');
});

console.log('\nThe share link');

await test('a link round-trips', async () => {
  const { shareLink } = harness().App;
  const input = { url: 'https://script.google.com/macros/s/AKfy123/exec', token: 'guest-secret', draftKey: '2026-08-24 League x9a2' };
  assert.deepEqual(shareLink.decode(shareLink.encode(input)), input);
});

await test('a non-ASCII league name survives the link', async () => {
  // btoa() throws on anything outside Latin-1, and draftKey() strips only
  // : \ / ? * [ ] ' " -- so "Café" reaches the encoder intact.
  const { shareLink } = harness().App;
  const input = { url: 'https://script/exec', token: 't', draftKey: '2026-08-24 Café Crème 🏈 x1y2' };
  assert.deepEqual(shareLink.decode(shareLink.encode(input)), input);
});

await test('a truncated or foreign link decodes to null rather than throwing', async () => {
  // Chat apps cut long links. A guest must land on "this link doesn't work",
  // never on an uncaught exception and a blank page.
  const { shareLink } = harness().App;
  const good = shareLink.encode({ url: 'https://script/exec', token: 't', draftKey: 'k' });
  assert.equal(shareLink.decode(good.slice(0, good.length - 12)), null);
  assert.equal(shareLink.decode(''), null);
  assert.equal(shareLink.decode('#something-else'), null);
  assert.equal(shareLink.decode('#v1.' + Buffer.from('{"u":"","k":""}').toString('base64')), null);
});

await test('build() produces a view.html link from wherever the operator is', async () => {
  const { shareLink } = harness().App;
  const link = shareLink.build({
    origin: 'https://draft.vercel.app/',
    url: 'https://script/exec',
    token: 'guest',
    draftKey: 'k',
  });
  assert.ok(link.startsWith('https://draft.vercel.app/view.html#v1.'), link);
  assert.deepEqual(shareLink.decode(link.slice(link.indexOf('#'))), {
    url: 'https://script/exec',
    token: 'guest',
    draftKey: 'k',
  });
});

await test('the token rides in the fragment, never the query string', async () => {
  // Fragments are not sent to the server, so the token stays out of request logs.
  const { shareLink } = harness().App;
  const link = shareLink.build({ origin: 'https://d.app', url: 'https://s/exec', token: 'secret-token', draftKey: 'k' });
  assert.ok(!link.slice(0, link.indexOf('#')).includes('secret-token'));
  assert.ok(!link.includes('?'), 'nothing should be in the query string at all');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
