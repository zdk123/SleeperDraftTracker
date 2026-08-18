#!/usr/bin/env node
// Plain-Node checks for the logic that would be expensive to get wrong on
// draft night: budget guardrails, slot assignment, and the sheet round-trip.
// Run with: node scripts/test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  stateToRanges,
  rowsToState,
  parseConfigHead,
  teamSummary,
  expandSlots,
  DEFAULT_ROSTER_SLOTS,
  TABS,
} from '../api/_lib/schema.js';

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

  const ranges = stateToRanges(store.get());
  const byTab = {};
  for (const r of ranges) byTab[r.range.split('!')[0]] = r.values;

  const restored = rowsToState({
    configRows: byTab[TABS.CONFIG],
    pickRows: byTab[TABS.PICKS],
    backupRows: byTab[TABS.BACKUP],
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

  const ranges = stateToRanges(store.get());
  const byTab = {};
  for (const r of ranges) byTab[r.range.split('!')[0]] = r.values;

  const restored = rowsToState({
    configRows: byTab[TABS.CONFIG],
    pickRows: byTab[TABS.PICKS],
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
  const ranges = stateToRanges(store.get());
  const picks = ranges.find((r) => r.range.startsWith(TABS.PICKS)).values;

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
  const rosters = stateToRanges(store.get()).find((r) => r.range.startsWith(TABS.ROSTERS)).values;
  assert.ok(!JSON.stringify(rosters).includes('Gone Soon'));
});

test('config head parses the revision for the stale-write guard', () => {
  const state = newDraft();
  store.addPick({ playerId: '1', playerName: 'X', position: 'QB', teamId: state.teams[0].id, price: 1, slot: 'QB' });
  const configRows = stateToRanges(store.get()).find((r) => r.range.startsWith(TABS.CONFIG)).values;
  const head = parseConfigHead(configRows);
  assert.equal(head.draftId, store.get().draftId);
  assert.equal(head.revision, store.get().revision);
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
