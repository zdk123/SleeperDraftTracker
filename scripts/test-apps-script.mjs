#!/usr/bin/env node
// Exercises apps-script/Code.gs -- the whole Google Sheets path.
//
// The script itself is loaded from disk and run unmodified (see
// fake-apps-script.mjs); only Google's APIs are faked. So a bug in the file the
// operator pastes into their spreadsheet is a failing test here, which matters
// because there is no other way to run that code outside Google.
//
// Run with: node scripts/test-apps-script.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAppsScript } from './fake-apps-script.mjs';
import { loadSchema } from './browser-modules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const App = { schema: loadSchema() };

function draft({ picks = 2, revision = 1, draftId = 'd-alpha', key = '2026-08-24 Test x1y2' } = {}) {
  const teams = [
    { id: 't1', name: 'Team One', manager: 'Alex' },
    { id: 't2', name: 'Team Two', manager: 'Sam' },
  ];
  const all = [
    { id: 'p1', playerId: '4034', playerName: 'Christian McCaffrey', position: 'RB', nflTeam: 'SF', teamId: 't1', price: 62, slot: 'RB1', timestamp: '2026-08-24T18:00:00.000Z', overrides: {}, note: '' },
    { id: 'p2', playerId: '6794', playerName: "Ja'Marr Chase", position: 'WR', nflTeam: 'CIN', teamId: 't2', price: 58, slot: 'FLEX', timestamp: '2026-08-24T18:01:00.000Z', overrides: { slot: true }, note: 'flex' },
    { id: 'p3', playerId: '4881', playerName: 'Josh Allen', position: 'QB', nflTeam: 'BUF', teamId: 't1', price: 41, slot: 'QB', timestamp: '2026-08-24T18:02:00.000Z', overrides: {}, note: '' },
  ];
  return {
    version: 1,
    draftId,
    draftKey: key,
    name: 'Test',
    revision,
    status: 'drafting',
    createdAt: '2026-08-24T17:00:00.000Z',
    updatedAt: '2026-08-24T18:02:00.000Z',
    settings: {
      budgetPerTeam: 200,
      minBid: 1,
      nominationStyle: 'rotating',
      rosterSlots: [
        { slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] },
        { slotKey: 'RB', label: 'RB', count: 2, eligiblePositions: ['RB'] },
        { slotKey: 'FLEX', label: 'FLEX', count: 1, eligiblePositions: ['RB', 'WR', 'TE'] },
      ],
    },
    nominationOrder: ['t1', 't2'],
    teams,
    picks: all.slice(0, picks),
  };
}

/** Exactly what public/js/backends.js sends for a sync. */
function syncPayload(state, extra = {}) {
  return {
    op: 'sync',
    draftKey: App.schema.draftKeyOf(state),
    draftId: state.draftId,
    revision: Number(state.revision) || 0,
    pickCount: state.picks.length,
    ranges: App.schema.stateToRanges(state),
    indexRow: App.schema.indexRow(state),
    logRow: App.schema.logRow(state, { client: 'test', summary: 'test' }),
    ...extra,
  };
}

console.log('\nDeployment basics');

test('a GET says something useful instead of throwing', () => {
  const { doGet } = loadAppsScript();
  const body = JSON.parse(doGet().getContent());
  assert.equal(body.ok, true);
  assert.match(body.message, /setup screen/i);
});

test('an unknown op is rejected, not silently ignored', () => {
  const { post } = loadAppsScript();
  const res = post({ op: 'drop-everything' });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, 'bad_request');
});

test('a bad token is refused', () => {
  const { post } = loadAppsScript({ writeToken: 'correct-horse' });
  assert.equal(post({ op: 'health', token: 'wrong' }).status, 401);
  assert.equal(post({ op: 'health', token: 'correct-horse' }).status, 200);
});

test('no token configured means no token required', () => {
  const { post } = loadAppsScript();
  assert.equal(post({ op: 'health' }).status, 200);
});

test('health does a real write and reads it back', () => {
  const { post, spreadsheet } = loadAppsScript();
  const res = post({ op: 'health' });
  assert.equal(res.ok, true);
  assert.match(res.message, /Connected to/);
  assert.ok(spreadsheet.getSheetByName('Drafts'), 'health must create the index tab');
});

console.log('\nWriting a draft');

test('a sync creates every tab the draft owns', () => {
  const { post, spreadsheet } = loadAppsScript();
  const state = draft();
  assert.equal(post(syncPayload(state)).ok, true);
  for (const kind of ['Config', 'Picks', 'Rosters', 'Budgets', 'Backup', 'Log']) {
    assert.ok(spreadsheet.getSheetByName(`${state.draftKey} ${kind}`), `missing ${kind} tab`);
  }
  assert.ok(spreadsheet.getSheetByName('Drafts'), 'missing the shared index');
});

test('the picks land in the sheet with their prices', () => {
  const { post, spreadsheet } = loadAppsScript();
  const state = draft({ picks: 3 });
  post(syncPayload(state));
  const rows = spreadsheet.getSheetByName(`${state.draftKey} Picks`).getDataRange().getValues();
  assert.deepEqual(rows[0].slice(0, 3), ['Pick #', 'Timestamp', 'Player']);
  assert.equal(rows[1][2], 'Christian McCaffrey');
  assert.equal(rows[1][8], 62);
  assert.equal(rows[3][2], 'Josh Allen');
});

test('a shrinking draft leaves no stale rows behind', () => {
  // The roster sheet is what gets re-typed into Sleeper afterwards, so a
  // deleted pick lingering there is a real, wrong-team-gets-the-player bug.
  const { post, spreadsheet } = loadAppsScript();
  const three = draft({ picks: 3, revision: 1 });
  post(syncPayload(three));
  const two = draft({ picks: 2, revision: 2 });
  post(syncPayload(two));

  const rows = spreadsheet.getSheetByName(`${two.draftKey} Picks`).getDataRange().getValues();
  const names = rows.slice(1).map((r) => r[2]).filter(Boolean);
  assert.deepEqual(names, ['Christian McCaffrey', "Ja'Marr Chase"]);
  assert.ok(!names.includes('Josh Allen'), 'the removed pick is still on the sheet');
});

test('the index keeps one row per draft and updates it in place', () => {
  const { post, spreadsheet } = loadAppsScript();
  post(syncPayload(draft({ picks: 2, revision: 1 })));
  post(syncPayload(draft({ picks: 3, revision: 2 })));
  post(syncPayload(draft({ picks: 1, revision: 1, draftId: 'd-beta', key: '2026-08-24 Other z9z9' })));

  const rows = spreadsheet.getSheetByName('Drafts').getDataRange().getValues();
  const body = rows.slice(1).filter((r) => r[0]);
  assert.equal(body.length, 2, 'expected exactly two drafts in the index');
  const first = body.find((r) => r[0] === '2026-08-24 Test x1y2');
  assert.equal(first[4], 3, 'the index should show the latest pick count');
});

test('the log is appended to, never rewritten', () => {
  const { post, spreadsheet } = loadAppsScript();
  post(syncPayload(draft({ revision: 1 })));
  post(syncPayload(draft({ revision: 2 })));
  post(syncPayload(draft({ revision: 3 })));
  const rows = spreadsheet.getSheetByName('2026-08-24 Test x1y2 Log').getDataRange().getValues();
  assert.equal(rows.filter((r) => r[0]).length, 3);
});

console.log('\nThe two guards that stop data loss');

test('an older revision of the same draft is refused', () => {
  const { post } = loadAppsScript();
  post(syncPayload(draft({ picks: 3, revision: 5 })));
  const res = post(syncPayload(draft({ picks: 1, revision: 4 })));
  assert.equal(res.status, 409);
  assert.equal(res.error.code, 'stale');
  assert.equal(res.serverRevision, 5);
});

test('the refused write changes nothing', () => {
  const { post, spreadsheet } = loadAppsScript();
  post(syncPayload(draft({ picks: 3, revision: 5 })));
  const before = spreadsheet.dump();
  post(syncPayload(draft({ picks: 1, revision: 4 })));
  assert.deepEqual(spreadsheet.dump(), before);
});

test('a different draft in the same tabs is refused', () => {
  const { post } = loadAppsScript();
  post(syncPayload(draft({ draftId: 'd-alpha', revision: 1 })));
  const res = post(syncPayload(draft({ draftId: 'd-intruder', revision: 99 })));
  assert.equal(res.status, 409);
  assert.equal(res.error.code, 'different_draft');
  assert.equal(res.serverDraftId, 'd-alpha');
});

test('force is the deliberate way past both guards', () => {
  const { post } = loadAppsScript();
  post(syncPayload(draft({ picks: 3, revision: 5 })));
  assert.equal(post(syncPayload(draft({ picks: 1, revision: 4 }), { force: true })).ok, true);
  assert.equal(post(syncPayload(draft({ draftId: 'd-other', revision: 1 }), { force: true })).ok, true);
});

test('an equal revision is refused too (a re-sent snapshot is not newer)', () => {
  const { post } = loadAppsScript();
  post(syncPayload(draft({ revision: 3 })));
  assert.equal(post(syncPayload(draft({ revision: 3 }))).error.code, 'stale');
});

console.log('\nReading it back');

test('list returns the drafts the spreadsheet holds', () => {
  const { post } = loadAppsScript();
  post(syncPayload(draft({ draftId: 'd-alpha' })));
  post(syncPayload(draft({ draftId: 'd-beta', key: '2026-08-24 Other z9z9' })));
  const drafts = App.schema.parseIndex(post({ op: 'list' }).rows);
  assert.deepEqual(drafts.map((d) => d.draftKey).sort(), [
    '2026-08-24 Other z9z9',
    '2026-08-24 Test x1y2',
  ]);
});

test('list on an untouched spreadsheet is empty, not an error', () => {
  const { post } = loadAppsScript();
  const res = post({ op: 'list' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows, []);
});

test('a draft survives a full round trip through the sheet', () => {
  const { post } = loadAppsScript();
  const original = draft({ picks: 3 });
  post(syncPayload(original));
  const rebuilt = App.schema.rowsToState(post({ op: 'load', draftKey: original.draftKey }));

  assert.equal(rebuilt.draftId, original.draftId);
  assert.equal(rebuilt.draftKey, original.draftKey);
  assert.equal(rebuilt.picks.length, 3);
  assert.deepEqual(
    rebuilt.picks.map((p) => [p.playerName, p.price, p.slot]),
    original.picks.map((p) => [p.playerName, p.price, p.slot])
  );
  assert.equal(rebuilt.settings.budgetPerTeam, 200);
  assert.equal(rebuilt.teams.length, 2);
});

test('a draft with an apostrophe in its key round-trips', () => {
  // Tab names are quoted into A1 ranges, where a stray apostrophe would split
  // the range. The script has to unquote what the client quoted.
  const { post, spreadsheet } = loadAppsScript();
  const state = draft({ key: "2026-08-24 Kurtz's League x1y2" });
  assert.equal(post(syncPayload(state)).ok, true);
  assert.ok(
    spreadsheet.getSheetByName("2026-08-24 Kurtz's League x1y2 Picks"),
    'the apostrophe was not unquoted correctly'
  );
  const rebuilt = App.schema.rowsToState(post({ op: 'load', draftKey: state.draftKey }));
  assert.equal(rebuilt.draftKey, state.draftKey);
});

console.log('\nThe script writes what the browser asked for');

test('every range the browser sends lands in the right tab, unchanged', () => {
  const state = draft({ picks: 3 });

  // The rows the browser hands to the script...
  const expected = new Map();
  for (const r of App.schema.stateToRanges(state)) {
    expected.set(r.range.split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'"), r.values);
  }

  // ...and what actually ends up in the spreadsheet.
  const { post, spreadsheet } = loadAppsScript();
  post(syncPayload(state));

  for (const [tab, values] of expected) {
    const sheet = spreadsheet.getSheetByName(tab);
    assert.ok(sheet, `the script never created ${tab}`);
    const written = sheet.getRange(1, 1, values.length, values[0].length).getValues();
    assert.deepEqual(written, values, `${tab} does not match what was sent`);
  }
});

test('the index row survives the round trip intact', () => {
  const state = draft({ picks: 3 });
  const { post, spreadsheet } = loadAppsScript();
  post(syncPayload(state));
  const written = spreadsheet.getSheetByName('Drafts').getDataRange().getValues();
  const row = written.find((r) => r[0] === App.schema.draftKeyOf(state));
  assert.deepEqual(row.slice(0, 9), App.schema.indexRow(state));
});

test('an apostrophe in a tab name is quoted, not left to split the range', () => {
  const state = draft({ key: "2026-08-24 Kurtz's League x1y2" });
  const ranges = App.schema.stateToRanges(state).map((r) => r.range);
  assert.ok(ranges.every((r) => r.startsWith("'")), 'tab names must be quoted');
  assert.equal(App.schema.quoteTab("a'b"), "'a''b'");
});

console.log('\nThe viewer token can read the draft and nothing else');

// Viewer mode hands a token to everyone at the party. These tests are the whole
// reason that is safe to do, so they check the sheet is untouched afterwards
// rather than trusting the status code alone -- a 401 that still wrote would
// pass a weaker test.

/** A script with both tokens set, holding one synced draft. */
function withTokens() {
  const script = loadAppsScript({ writeToken: 'operator-secret', viewToken: 'guest-secret' });
  const state = draft({ picks: 3, revision: 5 });
  const res = script.post({ ...syncPayload(state), token: 'operator-secret' });
  assert.equal(res.ok, true, 'setup sync should succeed');
  return { ...script, state };
}

test('the viewer token cannot sync', () => {
  const { post, spreadsheet, state } = withTokens();
  const before = JSON.stringify(spreadsheet.getSheetByName(`${state.draftKey} Picks`).getDataRange().getValues());

  const res = post({ ...syncPayload(draft({ picks: 1, revision: 99 })), token: 'guest-secret' });

  assert.equal(res.status, 401, 'a guest must never be able to write the draft');
  const after = JSON.stringify(spreadsheet.getSheetByName(`${state.draftKey} Picks`).getDataRange().getValues());
  assert.equal(after, before, 'the refused sync must change nothing at all');
});

test('the viewer token cannot force past the guards either', () => {
  const { post, spreadsheet, state } = withTokens();
  const before = JSON.stringify(spreadsheet.getSheetByName(`${state.draftKey} Picks`).getDataRange().getValues());
  const res = post({ ...syncPayload(draft({ picks: 1, revision: 1 })), force: true, token: 'guest-secret' });
  assert.equal(res.status, 401, 'force must not be a way around the token check');
  const after = JSON.stringify(spreadsheet.getSheetByName(`${state.draftKey} Picks`).getDataRange().getValues());
  assert.equal(after, before);
});

test('the viewer token cannot call health, which writes despite its name', () => {
  // health_() stamps Drafts!L1 on every call. It reads like a read; it isn't.
  const { post, spreadsheet } = withTokens();
  const cell = () => spreadsheet.getSheetByName('Drafts').getRange('L1').getValue();
  const before = cell();

  assert.equal(post({ op: 'health', token: 'guest-secret' }).status, 401);
  assert.equal(cell(), before, 'a refused health check must not have written');
});

test('the viewer token can poll, load and list', () => {
  const { post, state } = withTokens();
  assert.equal(post({ op: 'poll', draftKey: state.draftKey, token: 'guest-secret' }).ok, true);
  assert.equal(post({ op: 'load', draftKey: state.draftKey, token: 'guest-secret' }).ok, true);
  assert.equal(post({ op: 'list', token: 'guest-secret' }).ok, true);
});

test('the operator token still does everything', () => {
  const { post, state } = withTokens();
  assert.equal(post({ op: 'health', token: 'operator-secret' }).status, 200);
  assert.equal(post({ op: 'poll', draftKey: state.draftKey, token: 'operator-secret' }).ok, true);
  assert.equal(post({ op: 'load', draftKey: state.draftKey, token: 'operator-secret' }).ok, true);
  assert.equal(
    post({ ...syncPayload(draft({ picks: 3, revision: 6 })), token: 'operator-secret' }).ok,
    true
  );
});

test('an empty token is refused when viewer mode is off', () => {
  // The bug this is shaped to prevent: `token === VIEW_TOKEN` with VIEW_TOKEN
  // unset ('') matches a caller sending token: '', which would open the whole
  // draft -- backup JSON included -- to anyone holding the URL.
  const { post } = loadAppsScript({ writeToken: 'operator-secret' });
  assert.equal(post({ op: 'load', draftKey: 'anything', token: '' }).status, 401);
  assert.equal(post({ op: 'poll', draftKey: 'anything', token: '' }).status, 401);
  assert.equal(post({ op: 'list', token: '' }).status, 401);
});

test('a missing token is refused when viewer mode is off', () => {
  const { post } = loadAppsScript({ writeToken: 'operator-secret' });
  assert.equal(post({ op: 'load', draftKey: 'anything' }).status, 401);
  assert.equal(post({ op: 'poll', draftKey: 'anything' }).status, 401);
});

test('a wrong viewer token is refused', () => {
  const { post, state } = withTokens();
  assert.equal(post({ op: 'load', draftKey: state.draftKey, token: 'guessed' }).status, 401);
});

test('an unset write token still means an open sheet', () => {
  // Preserving today's behaviour: someone running without any token at all is
  // not broken by viewer mode existing.
  const { post } = loadAppsScript();
  assert.equal(post({ op: 'health' }).status, 200);
  assert.equal(post({ op: 'list' }).ok, true);
  assert.equal(post({ op: 'poll', draftKey: 'nothing here' }).ok, true);
});

console.log('\nPolling is the cheap question');

test('poll reports the revision the last sync wrote', () => {
  const { post, state } = withTokens();
  const res = post({ op: 'poll', draftKey: state.draftKey, token: 'guest-secret' });
  assert.equal(res.found, true);
  assert.equal(res.revision, 5);
  assert.equal(res.draftId, state.draftId);
  // Deliberately not `status`: reply() overwrites that with the HTTP code.
  assert.equal(res.draftStatus, 'drafting', 'poll must report the draft status, which configHead_ had to learn to read');
  assert.equal(res.status, 200, 'and the envelope keeps carrying the HTTP code');
});

test('poll follows the revision as the draft moves', () => {
  const { post, state } = withTokens();
  post({ ...syncPayload(draft({ picks: 3, revision: 12 })), token: 'operator-secret' });
  assert.equal(post({ op: 'poll', draftKey: state.draftKey, token: 'guest-secret' }).revision, 12);
});

test('poll on a draft the sheet has never held says so rather than failing', () => {
  const { post } = withTokens();
  const res = post({ op: 'poll', draftKey: '2099-01-01 Ghost zzzz', token: 'guest-secret' });
  assert.equal(res.ok, true);
  assert.equal(res.found, false, 'this is what tells a viewer its link is stale');
  assert.equal(res.revision, 0);
});

test('poll never takes the lock, so it cannot delay the operator', () => {
  // sync_ holds the script lock for the length of a write. If poll_ took it too,
  // a dozen phones would serialise against every pick the operator enters.
  const source = readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const pollBody = source.slice(source.indexOf('function poll_('), source.indexOf('function load_('));
  assert.ok(pollBody.length > 0, 'poll_ should exist');
  assert.ok(!/LockService/.test(pollBody), 'poll_ must not take the script lock');
  const loadBody = source.slice(source.indexOf('function load_('), source.indexOf('// --- sheet helpers'));
  assert.ok(!/LockService/.test(loadBody), 'load_ must not take the script lock');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
