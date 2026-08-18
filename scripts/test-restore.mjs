#!/usr/bin/env node
// Covers public/js/restore.js -- the operator's recovery path.
//
// This file had no tests at all, which is exactly why compare() shipped reading
// the revision off the wrong object and answering "the sheet matches this
// computer" no matter how far apart the two were. That is the single answer an
// operator has to be able to trust, so every verdict is pinned here.
//
// Run with: node scripts/test-restore.mjs

import assert from 'node:assert/strict';
import { loadBrowserModules } from './browser-modules.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  FAIL ${name}\n       ${err.message}`);
    });
}

/**
 * restore.js destructures App.sync when it loads, so the fake has to be in
 * place first. Only fetchRemote is used.
 */
function harness(remoteResponse) {
  const calls = [];
  const sync = {
    async fetchRemote(draftKey) {
      calls.push(draftKey);
      if (remoteResponse instanceof Error) throw remoteResponse;
      return typeof remoteResponse === 'function' ? remoteResponse(draftKey) : remoteResponse;
    },
  };
  const App = loadBrowserModules(
    ['utils.js', 'schema.js', 'state.js', 'persistence.js', 'restore.js'],
    { sync }
  );
  return { App, calls };
}

/** The shape sheetBackend.load() actually returns: revision lives on .state. */
function remoteDraft({ revision = 1, picks = 0, draftId = 'd1', draftKey = 'k1' } = {}) {
  return {
    ok: true,
    found: true,
    state: {
      version: 1,
      draftId,
      draftKey,
      revision,
      status: 'drafting',
      settings: { budgetPerTeam: 200, minBid: 1, rosterSlots: [], nominationStyle: 'rotating' },
      nominationOrder: [],
      teams: [{ id: 't1', name: 'Team One' }],
      picks: Array.from({ length: picks }, (_, i) => ({
        id: `p${i}`, playerId: `x${i}`, playerName: `P${i}`, teamId: 't1', price: 1, slot: 'QB',
      })),
    },
  };
}

function localDraft({ revision = 1, picks = 0, draftKey = 'k1' } = {}) {
  return {
    draftId: 'd1',
    draftKey,
    revision,
    picks: Array.from({ length: picks }, (_, i) => ({ id: `l${i}`, playerName: `L${i}` })),
    teams: [{ id: 't1', name: 'Team One' }],
  };
}

console.log('\nComparing this computer against the sheet');

await test('an identical draft reports a match', async () => {
  const { App } = harness(remoteDraft({ revision: 4, picks: 3 }));
  const { verdict } = await App.restore.compare(localDraft({ revision: 4, picks: 3 }));
  assert.equal(verdict, 'match');
});

await test('a newer local draft reports local-ahead', async () => {
  // The regression: the revision is on remote.state, not on remote. Reading it
  // from the envelope made this comparison undefined and always fell through
  // to "match".
  const { App } = harness(remoteDraft({ revision: 2, picks: 1 }));
  const { verdict } = await App.restore.compare(localDraft({ revision: 9, picks: 40 }));
  assert.equal(verdict, 'local-ahead');
});

await test('a newer sheet reports remote-ahead', async () => {
  const { App } = harness(remoteDraft({ revision: 30, picks: 50 }));
  const { verdict } = await App.restore.compare(localDraft({ revision: 4, picks: 2 }));
  assert.equal(verdict, 'remote-ahead');
});

await test('equal revisions with different picks is a divergence, not a match', async () => {
  const { App } = harness(remoteDraft({ revision: 7, picks: 12 }));
  const { verdict } = await App.restore.compare(localDraft({ revision: 7, picks: 30 }));
  assert.equal(verdict, 'diverged', 'a silent disagreement must not read as "match"');
});

await test('a draft the sheet has never seen reports local-only', async () => {
  const { App } = harness({ ok: true, found: false, state: null });
  const { verdict } = await App.restore.compare(localDraft());
  assert.equal(verdict, 'local-only');
});

await test('no local draft at all reports remote-only', async () => {
  const { App, calls } = harness(remoteDraft({ picks: 5 }));
  const { verdict } = await App.restore.compare(null);
  assert.equal(verdict, 'remote-only');
  assert.deepEqual(calls, [null], 'with no local draft it must ask for the list, not a key');
});

await test('an unreachable sheet reports no-remote rather than throwing', async () => {
  const { App } = harness(new Error('network down'));
  const { verdict, remote } = await App.restore.compare(localDraft());
  assert.equal(verdict, 'no-remote');
  assert.equal(remote, null);
});

await test('the draft key is what gets looked up', async () => {
  const { App, calls } = harness(remoteDraft({ draftKey: '2026-08-24 League x9a2' }));
  await App.restore.compare(localDraft({ draftKey: '2026-08-24 League x9a2' }));
  assert.deepEqual(calls, ['2026-08-24 League x9a2']);
});

console.log('\nAdopting the sheet’s copy');

await test('adopting installs the sheet’s picks', async () => {
  const { App } = harness(remoteDraft({ revision: 5, picks: 6 }));
  const remote = remoteDraft({ revision: 5, picks: 6 });
  const next = App.restore.adoptRemote(remote);
  assert.equal(next.picks.length, 6);
  assert.equal(App.store.get().picks.length, 6);
});

await test('adopting bumps past the sheet’s revision so the next sync sticks', async () => {
  // Adopting at or below the sheet's revision would be rejected as stale by the
  // very guard that protects the sheet, stranding the restored draft.
  const { App } = harness(remoteDraft());
  const next = App.restore.adoptRemote(remoteDraft({ revision: 12 }));
  assert.ok(next.revision > 12, `expected > 12, got ${next.revision}`);
});

await test('listRemote returns the sheet’s drafts', async () => {
  const { App } = harness({ ok: true, found: false, drafts: [{ draftKey: 'a' }, { draftKey: 'b' }] });
  assert.deepEqual((await App.restore.listRemote()).map((d) => d.draftKey), ['a', 'b']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
