#!/usr/bin/env node
// Exercises the sync/state/health handlers against a stubbed Google API: real
// JWT signing with a generated key, but the token and Sheets endpoints are
// faked so this runs offline and without a GCP project.
//
// The stale-write guard and the full-snapshot rewrite are the two pieces most
// likely to lose data if they regress, so they get the most attention here.
//
// Run with: node scripts/test-sync.mjs

import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

// --- fake credentials -------------------------------------------------------

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

process.env.GOOGLE_SA_EMAIL = 'draft-writer@test.iam.gserviceaccount.com';
process.env.GOOGLE_SA_PRIVATE_KEY_B64 = Buffer.from(privateKey).toString('base64');
process.env.SHEETS_SPREADSHEET_ID = 'sheet_test_123';
process.env.APP_WRITE_TOKEN = 'secret-token';

// --- fake Google -------------------------------------------------------------

const sheet = {
  tabs: new Set(),
  values: new Map(), // range -> rows
  appended: [],
  tokenRequests: 0,
  failNext: null,
};

function rangeTab(range) {
  return range.split('!')[0].replace(/^'|'$/g, '');
}

globalThis.fetch = async (url, options = {}) => {
  const href = typeof url === 'string' ? url : url.toString();
  const json = (status, body) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });

  if (href.startsWith('https://oauth2.googleapis.com/token')) {
    sheet.tokenRequests += 1;
    return json(200, { access_token: 'fake-token', expires_in: 3600 });
  }

  if (sheet.failNext) {
    const { status, body } = sheet.failNext;
    sheet.failNext = null;
    return json(status, body);
  }

  const u = new URL(href);

  // spreadsheets.get (metadata)
  if (/\/spreadsheets\/[^/:]+$/.test(u.pathname)) {
    return json(200, {
      properties: { title: 'Test Draft Sheet' },
      sheets: [...sheet.tabs].map((t) => ({ properties: { title: t } })),
    });
  }

  // spreadsheets.batchUpdate (addSheet)
  if (u.pathname.endsWith(':batchUpdate') && !u.pathname.includes('/values')) {
    const body = JSON.parse(options.body);
    for (const req of body.requests || []) {
      if (req.addSheet) sheet.tabs.add(req.addSheet.properties.title);
    }
    return json(200, { replies: [] });
  }

  // values.batchUpdate
  if (u.pathname.endsWith('/values:batchUpdate')) {
    const body = JSON.parse(options.body);
    for (const entry of body.data) sheet.values.set(entry.range, entry.values);
    return json(200, { totalUpdatedCells: 1 });
  }

  // values.batchGet
  if (u.pathname.endsWith('/values:batchGet')) {
    const ranges = u.searchParams.getAll('ranges');
    return json(200, {
      valueRanges: ranges.map((r) => ({ range: r, values: lookup(r) })),
    });
  }

  // values.append
  if (u.pathname.includes('/values/') && u.pathname.endsWith(':append')) {
    const body = JSON.parse(options.body);
    sheet.appended.push(...body.values);
    return json(200, { updates: { updatedRows: body.values.length } });
  }

  // values.get
  if (u.pathname.includes('/values/')) {
    const range = decodeURIComponent(u.pathname.split('/values/')[1]);
    return json(200, { values: lookup(range) });
  }

  throw new Error(`unexpected fetch: ${href}`);
};

/** Returns whatever was last written to a range on the same tab. */
function lookup(range) {
  if (sheet.values.has(range)) return sheet.values.get(range);
  const tab = rangeTab(range);
  for (const [key, value] of sheet.values) {
    if (rangeTab(key) === tab) return value;
  }
  return [];
}

// --- fake req/res ------------------------------------------------------------

function mockReq({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = url;
  req.headers = { 'x-draft-token': 'secret-token', ...headers };
  return req;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      this.headersSent = true;
      this.body = chunk ? JSON.parse(chunk) : null;
    },
  };
  return res;
}

// --- test harness ------------------------------------------------------------

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

const { default: syncHandler } = await import('../api/sync.js');
const { default: stateHandler } = await import('../api/state.js');
const { default: healthHandler } = await import('../api/health.js');
const { TAB_KINDS, INDEX_TAB, parseIndex } = await import('../api/_lib/schema.js');

/** Finds the rows written to one kind of tab, for whichever draft. */
function tabOfKind(kind, keyContains) {
  for (const [range, values] of sheet.values) {
    const tab = rangeTab(range);
    if (!tab.endsWith(' ' + kind)) continue;
    if (keyContains && !tab.includes(keyContains)) continue;
    return values;
  }
  return null;
}

function draftState({ revision = 1, picks = [], draftId = 'draft_a', draftKey, name = '' } = {}) {
  return {
    version: 1,
    draftId,
    draftKey: draftKey || `2026-08-17 ${draftId}`,
    name,
    revision,
    status: 'drafting',
    updatedAt: new Date().toISOString(),
    settings: {
      budgetPerTeam: 200,
      minReservePerOpenSlot: 1,
      rosterSlots: [
        { slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] },
        { slotKey: 'RB', label: 'RB', count: 2, eligiblePositions: ['RB'] },
      ],
      sleeperLeagueId: null,
    },
    teams: [
      { id: 't1', name: 'Sharks', manager: 'Alex', sleeperUserId: '' },
      { id: 't2', name: 'Bears', manager: 'Sam', sleeperUserId: '' },
    ],
    picks,
  };
}

const pick = (over) => ({
  id: 'p1',
  playerId: '4046',
  playerName: 'Patrick Mahomes',
  position: 'QB',
  nflTeam: 'KC',
  teamId: 't1',
  price: 45,
  slot: 'QB',
  timestamp: new Date().toISOString(),
  overrides: { budget: false, slot: false },
  note: '',
  ...over,
});

async function callSync(body) {
  const res = mockRes();
  await syncHandler(mockReq({ method: 'POST', url: '/api/sync', body }), res);
  return res;
}

console.log('\nAuth');

await test('signs a JWT and gets a token with a real key', async () => {
  const res = await callSync({ state: draftState({ picks: [pick()] }) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(sheet.tokenRequests >= 1, 'should have exchanged a JWT for a token');
});

await test('the access token is cached, not re-fetched every call', async () => {
  const before = sheet.tokenRequests;
  await callSync({ state: draftState({ revision: 2, picks: [pick()] }) });
  assert.equal(sheet.tokenRequests, before, 'token should be reused within its lifetime');
});

await test('a wrong token is rejected', async () => {
  const res = mockRes();
  await syncHandler(
    mockReq({ method: 'POST', url: '/api/sync', body: { state: draftState() }, headers: { 'x-draft-token': 'nope' } }),
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'bad_token');
});

console.log('\nWriting a snapshot');

await test('creates this draft\'s own tabs plus the shared index', () => {
  for (const kind of Object.values(TAB_KINDS)) {
    const expected = `2026-08-17 draft_a ${kind}`;
    assert.ok(sheet.tabs.has(expected), `missing tab ${expected}`);
  }
  assert.ok(sheet.tabs.has(INDEX_TAB), 'missing the shared index tab');
});

await test('writes every derived tab in one batch', () => {
  for (const kind of [TAB_KINDS.CONFIG, TAB_KINDS.PICKS, TAB_KINDS.ROSTERS, TAB_KINDS.BUDGETS, TAB_KINDS.BACKUP]) {
    assert.ok(tabOfKind(kind), `no data written for ${kind}`);
  }
});

await test('the shared index lists the draft', () => {
  const rows = [...sheet.values.entries()].find(([r]) => rangeTab(r) === INDEX_TAB);
  assert.ok(rows, 'index tab was never written');
  const listed = parseIndex(rows[1]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].draftKey, '2026-08-17 draft_a');
});

await test('the rosters tab carries the player and price', () => {
  const flat = JSON.stringify(tabOfKind(TAB_KINDS.ROSTERS));
  assert.ok(flat.includes('Patrick Mahomes'), 'player missing from Rosters');
  assert.ok(flat.includes('Sharks'), 'team name missing from Rosters');
  assert.ok(flat.includes('45'), 'price missing from Rosters');
});

await test('the budgets tab computes remaining and max bid', () => {
  const budgets = tabOfKind(TAB_KINDS.BUDGETS);
  const sharks = budgets.find((row) => row[0] === 'Sharks');
  assert.ok(sharks, 'no Sharks row');
  assert.equal(sharks[3], 45, 'spent');
  assert.equal(sharks[4], 155, 'remaining');
  assert.equal(sharks[5], 1, 'slots filled');
  assert.equal(sharks[6], 2, 'slots open');
  assert.equal(sharks[7], 154, 'max bid = 155 - 1 reserved');
});

await test('appends one audit row per accepted sync', () => {
  assert.ok(sheet.appended.length >= 2, `expected log rows, got ${sheet.appended.length}`);
  const last = sheet.appended[sheet.appended.length - 1];
  assert.equal(last.length, 7, 'log row shape');
  assert.ok(Number.isFinite(Number(last[1])), 'revision column');
});

console.log('\nStale-write guard');

await test('rejects a snapshot older than the sheet', async () => {
  const res = await callSync({ state: draftState({ revision: 1, picks: [] }) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'stale');
  assert.equal(res.body.serverRevision, 2);
});

await test('a stale rejection does not touch the sheet', () => {
  assert.ok(
    JSON.stringify(tabOfKind(TAB_KINDS.ROSTERS)).includes('Patrick Mahomes'),
    'good data was clobbered by a stale write'
  );
});

await test('an equal revision is also rejected', async () => {
  const res = await callSync({ state: draftState({ revision: 2, picks: [] }) });
  assert.equal(res.statusCode, 409);
});

await test('force:true overwrites deliberately', async () => {
  const res = await callSync({ state: draftState({ revision: 1, picks: [] }), force: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.forced, true);
  assert.ok(
    !JSON.stringify(tabOfKind(TAB_KINDS.ROSTERS, 'draft_a')).includes('Patrick Mahomes'),
    'force should have replaced the data'
  );
});

await test('a second draft coexists instead of replacing the first', async () => {
  // The case that used to destroy a live backup: an unrelated draft syncing to
  // the same spreadsheet. Each draft now owns its own tabs, so this is simply
  // allowed -- the isolation is structural rather than a rule that has to hold.
  const res = await callSync({
    state: draftState({ draftId: 'draft_b', revision: 1, picks: [pick({ playerName: 'Other Guy' })] }),
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const second = JSON.stringify(tabOfKind(TAB_KINDS.PICKS, 'draft_b'));
  assert.ok(second.includes('Other Guy'), 'the second draft was not written');
  assert.ok(!second.includes('Patrick Mahomes'), 'the two drafts are sharing a tab');
});

await test('the index lists both drafts', () => {
  const rows = [...sheet.values.entries()].find(([r]) => rangeTab(r) === INDEX_TAB)[1];
  const listed = parseIndex(rows);
  assert.equal(listed.length, 2, JSON.stringify(listed.map((d) => d.draftKey)));
  assert.ok(listed.some((d) => d.draftKey.includes('draft_a')));
  assert.ok(listed.some((d) => d.draftKey.includes('draft_b')));
});

await test('a key collision between different drafts is still refused', async () => {
  // Same tabs, different draft id -- the only way two drafts can still meet.
  const res = await callSync({
    state: draftState({ draftId: 'draft_intruder', draftKey: '2026-08-17 draft_b', revision: 99 }),
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'different_draft');
  assert.ok(res.body.serverDraftId, 'should say which draft is in those tabs');
  assert.ok(
    JSON.stringify(tabOfKind(TAB_KINDS.PICKS, 'draft_b')).includes('Other Guy'),
    'the refused write must not have touched anything'
  );
});

await test('a deliberate takeover of those tabs is allowed', async () => {
  const res = await callSync({
    state: draftState({ draftId: 'draft_intruder', draftKey: '2026-08-17 draft_b', revision: 99 }),
    force: true,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.forced, true);
});

console.log('\nDeletes leave no stale rows');

await test('removing a pick clears it from the sheet', async () => {
  const two = [pick(), pick({ id: 'p2', playerId: '4034', playerName: 'Bijan Robinson', position: 'RB', slot: 'RB1', price: 60, teamId: 't2' })];
  await callSync({ state: draftState({ draftId: 'draft_c', revision: 10, picks: two }), force: true });
  let picks = tabOfKind(TAB_KINDS.PICKS, 'draft_c');
  assert.ok(JSON.stringify(picks).includes('Bijan Robinson'));

  await callSync({ state: draftState({ draftId: 'draft_c', revision: 11, picks: [two[0]] }) });
  picks = tabOfKind(TAB_KINDS.PICKS, 'draft_c');
  assert.ok(!JSON.stringify(picks).includes('Bijan Robinson'), 'deleted pick still on the sheet');
  assert.ok(JSON.stringify(picks).includes('Patrick Mahomes'), 'surviving pick was lost');
});

console.log('\nRestore');

await test('lists the drafts in the spreadsheet', async () => {
  const res = mockRes();
  await stateHandler(mockReq({ url: '/api/state' }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.drafts), 'expected a draft list');
  assert.ok(res.body.drafts.length >= 2, JSON.stringify(res.body.drafts));
});

await test('rebuilds one named draft from the sheet', async () => {
  const res = mockRes();
  await stateHandler(mockReq({ url: '/api/state?draft=' + encodeURIComponent('2026-08-17 draft_c') }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.found, true);
  assert.equal(res.body.state.picks.length, 1);
  assert.equal(res.body.state.picks[0].playerName, 'Patrick Mahomes');
  assert.equal(res.body.state.teams.length, 2);
  assert.equal(res.body.state.settings.budgetPerTeam, 200);
});

console.log('\nError handling');

await test('a 403 from Sheets is reported as a sharing problem, not a quota one', async () => {
  sheet.failNext = {
    status: 403,
    body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
  };
  const res = await callSync({ state: draftState({ draftId: 'draft_d', revision: 99, picks: [] }), force: true });
  assert.equal(res.body.error.code, 'sheet_not_shared');
  assert.ok(/share/i.test(res.body.error.hint || ''), 'should hint at sharing the sheet');
});

await test('a rate-limit response is reported as a quota problem', async () => {
  sheet.failNext = {
    status: 429,
    body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for writes' } },
  };
  const res = await callSync({ state: draftState({ draftId: 'draft_d', revision: 99, picks: [] }), force: true });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'quota_exceeded');
});

await test('malformed state is refused', async () => {
  const res = await callSync({ state: { nope: true } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'bad_state');
});

await test('GET is refused on the sync endpoint', async () => {
  const res = mockRes();
  await syncHandler(mockReq({ method: 'GET', url: '/api/sync' }), res);
  assert.equal(res.statusCode, 405);
});

console.log('\nHealth check');

await test('reports a healthy round-trip', async () => {
  const res = mockRes();
  await healthHandler(mockReq({ url: '/api/health' }), res);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.canRead, true);
  assert.equal(res.body.canWrite, true);
  assert.equal(res.body.sheetTitle, 'Test Draft Sheet');
});

await test('surfaces a credentials failure clearly', async () => {
  sheet.failNext = {
    status: 403,
    body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
  };
  const res = mockRes();
  await healthHandler(mockReq({ url: '/api/health' }), res);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.errorCode, 'sheet_not_shared');
  assert.ok(res.body.hint);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
