#!/usr/bin/env node
// Plain-Node checks for the logic that would be expensive to get wrong on
// draft night: budget guardrails, slot assignment, and the sheet round-trip.
// Run with: node scripts/test.mjs

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  stateToRanges,
  rowsToState,
  parseConfigHead,
  teamSummary,
  expandSlots,
  draftKeyOf,
  tabsFor,
  indexRowsWith,
  parseIndex,
  DEFAULT_ROSTER_SLOTS,
  TAB_KINDS,
} from '../api/_lib/schema.js';
import { indexRow } from '../api/_lib/schema.js';
import { parseEnv, loadEnvFile } from '../api/_lib/env.js';
import {
  generate,
  SOURCE as SCHEMA_SOURCE,
  TARGET as SCHEMA_TARGET,
} from './build-schema-browser.mjs';

/** Ranges are now quoted per-draft tab names, e.g. `'2026-08-17 x1y2 Picks'!A1:L500`. */
function rangesByKind(state) {
  const out = {};
  for (const r of stateToRanges(state)) {
    const tab = r.range.split('!')[0].replace(/^'|'$/g, '');
    for (const kind of Object.values(TAB_KINDS)) {
      if (tab.endsWith(' ' + kind)) out[kind] = r.values;
    }
  }
  return out;
}

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

// --- load the browser modules into a fake window --------------------------

function loadBrowserModules() {
  const win = { DraftApp: {} };
  const sandbox = {
    window: win,
    document: { addEventListener() {} },
    console,
    localStorage: {
      store: new Map(),
      getItem(k) {
        return this.store.has(k) ? this.store.get(k) : null;
      },
      setItem(k, v) {
        this.store.set(k, String(v));
      },
      removeItem(k) {
        this.store.delete(k);
      },
    },
    navigator: { onLine: true },
    setInterval() {},
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error('no network in tests');
    },
  };
  sandbox.globalThis = sandbox;

  const files = ['utils.js', 'state.js', 'validation.js'];
  for (const file of files) {
    const code = readFileSync(join(ROOT, 'public', 'js', file), 'utf8');
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'console', code);
    fn(win, sandbox.document, sandbox.localStorage, sandbox.navigator, console);
  }
  return win.DraftApp;
}

const App = loadBrowserModules();
const { store, validation } = App;

function newDraft({ budget = 200, teams = 2, slots, nominationStyle = 'rotating' } = {}) {
  return store.create({
    teams: Array.from({ length: teams }, (_, i) => ({ name: `Team ${i + 1}` })),
    settings: {
      budgetPerTeam: budget,
      minBid: 1,
      nominationStyle,
      rosterSlots: slots || [
        { slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] },
        { slotKey: 'RB', label: 'RB', count: 2, eligiblePositions: ['RB'] },
        { slotKey: 'FLEX', label: 'FLEX', count: 1, eligiblePositions: ['RB', 'WR', 'TE'] },
      ],
    },
  });
}

/** A draft with enough shape to exercise every tab: picks, overrides, notes. */
function fullDraftState() {
  const state = newDraft({ budget: 200, teams: 3 });
  state.name = "Kurtz's League";
  state.draftKey = "2026-08-24 Kurtz's League x9a2";
  const [a, b] = state.teams;
  store.addPick({
    playerId: '4034', playerName: 'Christian McCaffrey', position: 'RB',
    nflTeam: 'SF', teamId: a.id, price: 62, slot: 'RB1',
  });
  store.addPick({
    playerId: '6794', playerName: 'Ja\'Marr Chase', position: 'WR',
    nflTeam: 'CIN', teamId: b.id, price: 58, slot: 'FLEX',
    overrides: { slot: true }, note: 'called out of order',
  });
  store.addPick({
    playerId: '4881', playerName: 'Josh Allen', position: 'QB',
    nflTeam: 'BUF', teamId: a.id, price: 41, slot: 'QB',
  });
  return state;
}

console.log('\nBudget guardrails');

test('max bid reserves $1 for every other open slot', () => {
  const state = newDraft({ budget: 200 });
  const team = state.teams[0].id;
  // 4 slots, none filled: can spend 200 - 3 = 197.
  assert.equal(store.teamSummary(team).maxBid, 197);
});

test('max bid shrinks as money is spent', () => {
  const state = newDraft({ budget: 100 });
  const team = state.teams[0].id;
  store.addPick({ playerName: 'A', position: 'QB', teamId: team, price: 50, slot: 'QB' });
  const s = store.teamSummary(team);
  assert.equal(s.remaining, 50);
  assert.equal(s.open, 3);
  assert.equal(s.maxBid, 48); // 50 - 2 reserved
});

test('a bid over max is blocked and NOT overridable (Sleeper enforces this)', () => {
  const state = newDraft({ budget: 10 });
  const team = state.teams[0].id;
  const result = validation.check({
    teamId: team,
    playerId: 'x1',
    playerName: 'Someone',
    position: 'QB',
    price: 10,
  });
  const blocker = result.blockers.find((b) => b.code === 'over_budget');
  assert.ok(blocker, 'expected an over_budget blocker');
  assert.equal(blocker.overridable, false, 'money rules cannot be waived');
  assert.equal(result.canOverride, false);
});

test('a bid below the $1 minimum is blocked', () => {
  const state = newDraft();
  const result = validation.check({
    teamId: state.teams[0].id,
    playerId: 'x1',
    playerName: 'Someone',
    position: 'QB',
    price: 0,
  });
  assert.ok(result.blockers.some((b) => b.code === 'below_min'));
});

test('a team must be able to fill every remaining spot at $1', () => {
  // $12 left with 10 spots to fill -> at most $3 on any one player.
  const state = newDraft({
    budget: 12,
    slots: [{ slotKey: 'BENCH', label: 'BN', count: 10, eligiblePositions: ['QB', 'RB'] }],
  });
  const team = state.teams[0].id;
  assert.equal(store.teamSummary(team).maxBid, 3);
});

test('a bid at exactly max is allowed', () => {
  const state = newDraft({ budget: 10 });
  const team = state.teams[0].id;
  const result = validation.check({
    teamId: team,
    playerId: 'x1',
    playerName: 'Someone',
    position: 'QB',
    price: 7, // 10 - 3 reserved
  });
  assert.equal(result.blockers.length, 0, JSON.stringify(result.blockers));
  assert.equal(result.ok, true);
});

test('last slot may use every remaining dollar', () => {
  const state = newDraft({ budget: 20, slots: [{ slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] }] });
  const team = state.teams[0].id;
  assert.equal(store.teamSummary(team).maxBid, 20);
});

console.log('\nDuplicate players');

test('drafting the same player twice is blocked and NOT overridable', () => {
  const state = newDraft();
  const [a, b] = state.teams;
  store.addPick({ playerId: 'p99', playerName: 'Josh Allen', position: 'QB', teamId: a.id, price: 40, slot: 'QB' });
  const result = validation.check({
    teamId: b.id,
    playerId: 'p99',
    playerName: 'Josh Allen',
    position: 'QB',
    price: 10,
  });
  const dup = result.blockers.find((x) => x.code === 'duplicate');
  assert.ok(dup, 'expected a duplicate blocker');
  assert.equal(dup.overridable, false);
  assert.equal(result.canOverride, false, 'duplicates must never be overridable');
});

test('duplicate detection also works for free-text names', () => {
  const state = newDraft();
  const [a, b] = state.teams;
  store.addPick({ playerName: 'Some Rookie', position: 'RB', teamId: a.id, price: 3, slot: 'RB1' });
  const result = validation.check({
    teamId: b.id,
    playerName: 'some rookie',
    position: 'RB',
    price: 2,
  });
  assert.ok(result.blockers.some((x) => x.code === 'duplicate'));
});

console.log('\nRoster slots');

test('a position with one open slot auto-assigns it', () => {
  const state = newDraft();
  const team = state.teams[0].id;
  const result = validation.check({ teamId: team, playerId: 'q', playerName: 'QB1', position: 'QB', price: 5 });
  assert.equal(result.slotOptions.length, 1);
  assert.equal(result.slotOptions[0].code, 'QB');
});

test('RB offers both RB slots and FLEX', () => {
  const state = newDraft();
  const team = state.teams[0].id;
  const result = validation.check({ teamId: team, playerId: 'r', playerName: 'RB1', position: 'RB', price: 5 });
  assert.deepEqual(result.slotOptions.map((s) => s.code).sort(), ['FLEX', 'RB1', 'RB2']);
});

test('a full position blocks (overridable) and offers any open slot', () => {
  const state = newDraft();
  const team = state.teams[0].id;
  store.addPick({ playerId: 'q1', playerName: 'QB A', position: 'QB', teamId: team, price: 5, slot: 'QB' });
  const result = validation.check({ teamId: team, playerId: 'q2', playerName: 'QB B', position: 'QB', price: 5 });
  const blocker = result.blockers.find((b) => b.code === 'slot_full');
  assert.ok(blocker, 'expected slot_full');
  assert.equal(blocker.overridable, true);
  assert.ok(result.slotOptions.length > 0, 'override should still offer slots');
});

test('a completely full roster blocks, not overridable', () => {
  const state = newDraft({ slots: [{ slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] }] });
  const team = state.teams[0].id;
  store.addPick({ playerId: 'q1', playerName: 'QB A', position: 'QB', teamId: team, price: 5, slot: 'QB' });
  const result = validation.check({ teamId: team, playerId: 'q2', playerName: 'QB B', position: 'QB', price: 1 });
  const blocker = result.blockers.find((b) => b.code === 'roster_full');
  assert.ok(blocker);
  assert.equal(blocker.overridable, false, 'a full team cannot bid at all');
});

console.log('\nNomination order');

test('a random order is a permutation, not a reshuffle of contents', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const shuffled = store.shuffled(ids);
  assert.deepEqual(shuffled.slice().sort(), ids.slice().sort());
  assert.equal(shuffled.length, ids.length);
});

test('rotating order repeats the same sequence each round', () => {
  const state = newDraft({ teams: 3, budget: 500 });
  const [a, b, c] = state.teams.map((t) => t.id);
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    seen.push(store.currentNominator());
    store.addPick({
      playerId: `p${i}`,
      playerName: `P${i}`,
      position: 'RB',
      teamId: state.teams[i % 3].id,
      price: 1,
      slot: store.eligibleOpenSlots(state.teams[i % 3].id, 'RB')[0]?.code || 'RB1',
    });
  }
  assert.deepEqual(seen, [a, b, c, a, b, c]);
});

test('snake order reverses on the second round', () => {
  const state = newDraft({ teams: 3, budget: 500, nominationStyle: 'snake' });
  const [a, b, c] = state.teams.map((t) => t.id);
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    seen.push(store.currentNominator());
    const team = state.teams[i % 3];
    store.addPick({
      playerId: `p${i}`,
      playerName: `P${i}`,
      position: 'RB',
      teamId: team.id,
      price: 1,
      slot: store.eligibleOpenSlots(team.id, 'RB')[0]?.code || 'RB1',
    });
  }
  assert.deepEqual(seen, [a, b, c, c, b, a]);
});

test('a full team is skipped in the nomination order', () => {
  const state = newDraft({
    teams: 2,
    budget: 50,
    slots: [{ slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] }],
  });
  const [a, b] = state.teams.map((t) => t.id);
  assert.equal(store.currentNominator(), a);
  // Team A fills its only slot, so it can no longer nominate.
  store.addPick({ playerId: 'q', playerName: 'QB A', position: 'QB', teamId: a, price: 5, slot: 'QB' });
  assert.equal(store.canBid(a), false);
  assert.equal(store.currentNominator(), b, 'a full team must be skipped');
});

test('nomination returns nothing once every team is full', () => {
  const state = newDraft({
    teams: 2,
    budget: 50,
    slots: [{ slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] }],
  });
  for (const team of state.teams) {
    store.addPick({
      playerId: `q${team.id}`,
      playerName: `QB ${team.id}`,
      position: 'QB',
      teamId: team.id,
      price: 5,
      slot: 'QB',
    });
  }
  assert.equal(store.currentNominator(), null);
});

test('a team out of money cannot bid even with spots open', () => {
  const state = newDraft({
    budget: 3,
    slots: [{ slotKey: 'BENCH', label: 'BN', count: 3, eligiblePositions: ['RB'] }],
  });
  const team = state.teams[0].id;
  // Spend down to exactly $1 per remaining spot: no room to bid above the floor.
  store.addPick({ playerId: 'r1', playerName: 'R1', position: 'RB', teamId: team, price: 1, slot: 'BN1' });
  const summary = store.teamSummary(team);
  assert.equal(summary.remaining, 2);
  assert.equal(summary.maxBid, 1, 'can only ever bid the minimum now');
  assert.equal(store.canBid(team), true, 'still allowed to bid the $1 minimum');
});

console.log('\nUndo and edit');

test('undo removes the last pick and restores the budget', () => {
  const state = newDraft({ budget: 100 });
  const team = state.teams[0].id;
  store.addPick({ playerId: 'a', playerName: 'A', position: 'QB', teamId: team, price: 30, slot: 'QB' });
  assert.equal(store.teamSummary(team).spent, 30);
  store.undoLast();
  assert.equal(store.teamSummary(team).spent, 0);
  assert.equal(store.get().picks.length, 0);
});

test('editing a price recomputes the budget', () => {
  const state = newDraft({ budget: 100 });
  const team = state.teams[0].id;
  const pick = store.addPick({ playerId: 'a', playerName: 'A', position: 'QB', teamId: team, price: 30, slot: 'QB' });
  store.updatePick(pick.id, { price: 12 });
  assert.equal(store.teamSummary(team).spent, 12);
});

test('every mutation bumps the revision', () => {
  const state = newDraft();
  const before = store.get().revision;
  store.addPick({ playerId: 'a', playerName: 'A', position: 'QB', teamId: state.teams[0].id, price: 1, slot: 'QB' });
  assert.ok(store.get().revision > before, 'revision must increase for the stale-write guard');
});

console.log('\nSheet mapping');

test('state survives a round-trip through the sheet rows', () => {
  const state = newDraft({ budget: 150, teams: 3 });
  const [a, b] = state.teams;
  store.addPick({ playerId: '4046', playerName: 'Patrick Mahomes', position: 'QB', nflTeam: 'KC', teamId: a.id, price: 42, slot: 'QB' });
  store.addPick({ playerId: '4034', playerName: 'Christian McCaffrey', position: 'RB', nflTeam: 'SF', teamId: b.id, price: 55, slot: 'RB1' });

  const byKind = rangesByKind(store.get());

  const restored = rowsToState({
    configRows: byKind[TAB_KINDS.CONFIG],
    pickRows: byKind[TAB_KINDS.PICKS],
    backupRows: byKind[TAB_KINDS.BACKUP],
  });

  assert.equal(restored.picks.length, 2);
  assert.equal(restored.teams.length, 3);
  assert.equal(restored.settings.budgetPerTeam, 150);
  assert.equal(restored.picks[0].playerName, 'Patrick Mahomes');
  assert.equal(restored.picks[1].price, 55);
  assert.equal(restored.draftId, store.get().draftId);
});

test('reconstruction works from Config+Picks alone when the backup tab is empty', () => {
  const state = newDraft({ budget: 150 });
  const team = state.teams[0].id;
  store.addPick({ playerId: '1', playerName: 'Player One', position: 'QB', nflTeam: 'KC', teamId: team, price: 10, slot: 'QB' });

  const byKind = rangesByKind(store.get());

  const restored = rowsToState({
    configRows: byKind[TAB_KINDS.CONFIG],
    pickRows: byKind[TAB_KINDS.PICKS],
    backupRows: [], // simulate a corrupt/empty backup tab
  });
  assert.equal(restored.picks.length, 1);
  assert.equal(restored.picks[0].playerName, 'Player One');
  assert.equal(restored.picks[0].teamId, team, 'team should resolve by name');
});

test('deleting a pick clears its old row (no stale trailing data)', () => {
  const state = newDraft();
  const team = state.teams[0].id;
  const p1 = store.addPick({ playerId: '1', playerName: 'Keep Me', position: 'QB', teamId: team, price: 5, slot: 'QB' });
  const p2 = store.addPick({ playerId: '2', playerName: 'Delete Me', position: 'RB', teamId: team, price: 8, slot: 'RB1' });
  void p1;

  store.removePick(p2.id);
  const picks = rangesByKind(store.get())[TAB_KINDS.PICKS];

  const flat = JSON.stringify(picks);
  assert.ok(!flat.includes('Delete Me'), 'deleted pick must not survive in the rewritten range');
  assert.ok(flat.includes('Keep Me'));
  // Row 2 is the first data row; row 3 must have been blanked out.
  assert.deepEqual(picks[2], new Array(picks[0].length).fill(''));
});

test('the rosters tab blanks out a removed player', () => {
  const state = newDraft();
  const team = state.teams[0].id;
  const pick = store.addPick({ playerId: '1', playerName: 'Gone Soon', position: 'QB', teamId: team, price: 5, slot: 'QB' });
  store.removePick(pick.id);
  const rosters = rangesByKind(store.get())[TAB_KINDS.ROSTERS];
  assert.ok(!JSON.stringify(rosters).includes('Gone Soon'));
});

test('config head parses the revision for the stale-write guard', () => {
  const state = newDraft();
  store.addPick({ playerId: '1', playerName: 'X', position: 'QB', teamId: state.teams[0].id, price: 1, slot: 'QB' });
  const configRows = rangesByKind(store.get())[TAB_KINDS.CONFIG];
  const head = parseConfigHead(configRows);
  assert.equal(head.draftId, store.get().draftId);
  assert.equal(head.revision, store.get().revision);
});

console.log('\nDraft keys and multi-draft isolation');

test('a key is dated, named and unique', () => {
  const key = App.utils.draftKey({
    name: 'Kurtz League',
    draftId: 'draft_abc1234',
    date: new Date(2026, 7, 17),
  });
  assert.match(key, /^2026-08-17 Kurtz League \w{4}$/, key);
});

test('a key is safe for both spreadsheet tabs and filenames', () => {
  const key = App.utils.draftKey({
    name: 'A/B: test [x] * ? \\ "quoted"',
    draftId: 'draft_zzzz9999',
    date: new Date(2026, 0, 5),
  });
  // Google rejects these outright in a tab name.
  for (const ch of [':', '\\', '/', '?', '*', '[', ']', "'"]) {
    assert.ok(!key.includes(ch), `key must not contain ${ch}: ${key}`);
  }
  assert.ok(key.startsWith('2026-01-05 '), key);
});

test('an unnamed draft still gets a usable key', () => {
  const key = App.utils.draftKey({ draftId: 'draft_qqqq1111', date: new Date(2026, 7, 1) });
  assert.match(key, /^2026-08-01 \w{4}$/, key);
});

test('two drafts write to entirely separate tabs', () => {
  const a = store.create({
    teams: [{ name: 'A' }, { name: 'B' }],
    name: 'Rehearsal',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  const aTabs = stateToRanges(a).map((r) => r.range.split('!')[0]);

  const b = store.create({
    teams: [{ name: 'A' }, { name: 'B' }],
    name: 'Real thing',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  const bTabs = stateToRanges(b).map((r) => r.range.split('!')[0]);

  const overlap = aTabs.filter((t) => bTabs.includes(t));
  assert.equal(overlap.length, 0, `tabs collide: ${overlap.join(', ')}`);
  assert.ok(aTabs.every((t) => t.includes('Rehearsal')), aTabs.join(' | '));
  assert.ok(bTabs.every((t) => t.includes('Real thing')), bTabs.join(' | '));
});

test('tab names with spaces are quoted for A1 ranges', () => {
  const state = store.create({
    teams: [{ name: 'A' }],
    name: 'My League',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  for (const { range } of stateToRanges(state)) {
    assert.ok(range.startsWith("'"), `unquoted range would be rejected by Sheets: ${range}`);
    assert.match(range, /^'[^']+'![A-Z]+\d+:[A-Z]+\d+$/, range);
  }
});

test('every tab kind belongs to the draft', () => {
  const state = store.create({
    teams: [{ name: 'A' }],
    name: 'Tabs',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  const expected = tabsFor(draftKeyOf(state));
  assert.equal(expected.length, 6);
  assert.ok(expected.every((t) => t.startsWith(draftKeyOf(state))));
});

test('the index keeps one row per draft and updates in place', () => {
  const a = store.create({
    teams: [{ name: 'A' }],
    name: 'First',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  store.addPick({ playerId: '1', playerName: 'P1', position: 'QB', teamId: a.teams[0].id, price: 5, slot: 'QB' });
  let rows = indexRowsWith([], store.get());
  assert.equal(parseIndex(rows).length, 1);
  assert.equal(parseIndex(rows)[0].picks, 1);

  // Same draft again: still one row, updated.
  store.addPick({ playerId: '2', playerName: 'P2', position: 'RB', teamId: a.teams[0].id, price: 6, slot: 'RB1' });
  rows = indexRowsWith(rows, store.get());
  assert.equal(parseIndex(rows).length, 1, 'the same draft must not be listed twice');
  assert.equal(parseIndex(rows)[0].picks, 2);

  // A different draft adds a second row without disturbing the first.
  store.create({
    teams: [{ name: 'B' }],
    name: 'Second',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  rows = indexRowsWith(rows, store.get());
  const listed = parseIndex(rows);
  assert.equal(listed.length, 2);
  assert.ok(listed.some((d) => d.name === 'First'), 'the earlier draft was dropped from the index');
  assert.ok(listed.some((d) => d.name === 'Second'));
});

test('state carries its key through a sheet round-trip', () => {
  const state = store.create({
    teams: [{ name: 'A' }, { name: 'B' }],
    name: 'Round Trip',
    settings: { budgetPerTeam: 100, minBid: 1, rosterSlots: DEFAULT_ROSTER_SLOTS },
  });
  store.addPick({ playerId: '9', playerName: 'Someone', position: 'QB', teamId: state.teams[0].id, price: 7, slot: 'QB' });
  const byKind = rangesByKind(store.get());
  const restored = rowsToState({
    configRows: byKind[TAB_KINDS.CONFIG],
    pickRows: byKind[TAB_KINDS.PICKS],
    backupRows: byKind[TAB_KINDS.BACKUP],
  });
  assert.equal(restored.draftKey, store.get().draftKey);
  assert.equal(restored.name, 'Round Trip');
});

console.log('\nShared helpers agree across client and server');

test('server teamSummary matches the client store', () => {
  const state = newDraft({ budget: 120 });
  const team = state.teams[0].id;
  store.addPick({ playerId: '1', playerName: 'A', position: 'QB', teamId: team, price: 33, slot: 'QB' });
  const clientSide = store.teamSummary(team);
  const serverSide = teamSummary(store.get(), team);
  assert.deepEqual(serverSide, clientSide, 'budget math must not diverge between board and sheet');
});

test('slot expansion numbers duplicates and leaves singles bare', () => {
  const slots = expandSlots(DEFAULT_ROSTER_SLOTS);
  const codes = slots.map((s) => s.code);
  assert.ok(codes.includes('QB'), 'single slot keeps its bare key');
  assert.ok(codes.includes('RB1') && codes.includes('RB2'));
  assert.equal(slots.length, 15);
});

console.log('\nDebounce (guards the sheet-sync starvation bug)');

await (async () => {
  const { debounce } = App.utils;

  await new Promise((resolve) => {
    let fired = 0;
    const fn = debounce(() => { fired += 1; }, 50);
    // Calls closer together than the wait, for longer than the wait.
    const iv = setInterval(() => fn(), 15);
    setTimeout(() => {
      clearInterval(iv);
      test('plain debounce defers while calls keep coming', () =>
        assert.equal(fired, 0, `fired ${fired} times`));
      resolve();
    }, 200);
  });

  await new Promise((resolve) => {
    let fired = 0;
    const fn = debounce(() => { fired += 1; }, 50, { maxWait: 100 });
    const iv = setInterval(() => fn(), 15);
    setTimeout(() => {
      clearInterval(iv);
      test('maxWait forces the work through during a sustained burst', () =>
        assert.ok(fired >= 1, `fired ${fired} times in 250ms with maxWait 100ms`));
      resolve();
    }, 250);
  });

  await new Promise((resolve) => {
    let fired = 0;
    const fn = debounce(() => { fired += 1; }, 30, { maxWait: 200 });
    fn();
    setTimeout(() => {
      test('a single call still fires after the normal wait', () =>
        assert.equal(fired, 1, `fired ${fired} times`));
      resolve();
    }, 120);
  });
})();

console.log('\nBrowser copy of the sheet mapping');

test('public/js/schema.js is in sync with api/_lib/schema.js', () => {
  const expected = generate(readFileSync(SCHEMA_SOURCE, 'utf8'));
  const committed = readFileSync(SCHEMA_TARGET, 'utf8');
  assert.equal(
    committed,
    expected,
    'public/js/schema.js is stale -- run: node scripts/build-schema-browser.mjs',
  );
});

test('the generated copy runs in a browser-shaped global and exports the mapping', () => {
  // Evaluate it the way a <script> tag would, with no Node globals in scope.
  const App = {};
  new Function('window', readFileSync(SCHEMA_TARGET, 'utf8'))({ DraftApp: App });
  assert.ok(App.schema, 'the generated file must define window.DraftApp.schema');
  for (const name of ['stateToRanges', 'indexRow', 'logRow', 'draftKeyOf', 'TAB_KINDS']) {
    assert.ok(App.schema[name], `missing ${name}`);
  }
});

test('server and browser produce byte-identical rows for the same state', () => {
  const App = {};
  new Function('window', readFileSync(SCHEMA_TARGET, 'utf8'))({ DraftApp: App });
  const state = fullDraftState();
  assert.deepEqual(App.schema.stateToRanges(state), stateToRanges(state));
  assert.deepEqual(App.schema.indexRow(state), indexRow(state));
  assert.deepEqual(App.schema.draftKeyOf(state), draftKeyOf(state));
});

console.log('\nOffline shell');

test('the service worker precaches everything index.html loads', () => {
  // A script in index.html but not in SHELL works perfectly until the wifi
  // drops and the page is reloaded -- which is the one moment the service
  // worker exists for.
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const sw = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');

  const referenced = [...html.matchAll(/(?:src|href)="((?:js|css|data)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(referenced.length > 10, 'expected to find the asset list in index.html');

  const missing = referenced.filter((asset) => !sw.includes(`'${asset}'`));
  assert.deepEqual(missing, [], `not precached by sw.js: ${missing.join(', ')}`);
});

test('the cached shell has no entries that no longer exist', () => {
  const sw = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/'((?:js|css|data)\/[^']+)'/g)].map((m) => m[1]);
  const gone = shell.filter((asset) => !existsSync(join(ROOT, 'public', asset)));
  assert.deepEqual(gone, [], `sw.js precaches missing files: ${gone.join(', ')}`);
});

console.log('\nCredentials from the environment');

test('a real environment variable beats the file', () => {
  const env = { GOOGLE_SA_EMAIL: 'from-shell@test.iam.gserviceaccount.com' };
  const path = join(ROOT, 'scripts', '.env.test-tmp');
  writeFileSync(path, 'GOOGLE_SA_EMAIL=from-file@test.iam.gserviceaccount.com\nAPP_WRITE_TOKEN=abc\n');
  try {
    const applied = loadEnvFile(path, env);
    assert.equal(env.GOOGLE_SA_EMAIL, 'from-shell@test.iam.gserviceaccount.com');
    assert.equal(env.APP_WRITE_TOKEN, 'abc');
    assert.deepEqual(applied, ['APP_WRITE_TOKEN']);
  } finally {
    rmSync(path, { force: true });
  }
});

test('a missing .env.local is not an error', () => {
  const env = {};
  assert.deepEqual(loadEnvFile(join(ROOT, 'scripts', 'nope.env'), env), []);
  assert.deepEqual(env, {});
});

test('base64 keys survive their own padding', () => {
  // A base64 private key ends in `=` padding, and indexOf('=') must not eat it.
  const key = Buffer.from('-----BEGIN PRIVATE KEY-----\nabc\n').toString('base64');
  assert.ok(key.endsWith('='), 'test needs a padded value to be meaningful');
  assert.equal(parseEnv(`GOOGLE_SA_PRIVATE_KEY_B64=${key}`).GOOGLE_SA_PRIVATE_KEY_B64, key);
});

test('the file tolerates how people actually write it', () => {
  const parsed = parseEnv(
    [
      '# a comment',
      '',
      'PLAIN=one',
      '  SPACED = two  ',
      'QUOTED="three"',
      "SINGLE='four'",
      'export EXPORTED=five',           // pasted from shell instructions
      'CRLF=six\r',                     // Notepad on Windows
      'EMPTY=',
      'JUST_A_WORD',                    // no `=`, ignored
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    PLAIN: 'one',
    SPACED: 'two',
    QUOTED: 'three',
    SINGLE: 'four',
    EXPORTED: 'five',
    CRLF: 'six',
    EMPTY: '',
  });
});

test('a lone quote is a value, not an unterminated string', () => {
  assert.equal(parseEnv('APP_WRITE_TOKEN="').APP_WRITE_TOKEN, '"');
});

console.log('\nPlayer data');

test('the generated player list looks sane', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'players.json'), 'utf8'));
  assert.ok(data.count > 500, `expected a real player list, got ${data.count}`);
  const positions = new Set(data.players.map((p) => p.p));
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    assert.ok(positions.has(pos), `missing position ${pos}`);
  }
  assert.ok(data.players.every((p) => p.k === p.k.toLowerCase()), 'search keys must be pre-lowercased');
  assert.ok(data.players.every((p) => p.id && p.n), 'every player needs an id and a name');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
