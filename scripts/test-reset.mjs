#!/usr/bin/env node
// Covers apps-script/Reset.gs -- the one-off script that clears test drafts out
// of a spreadsheet.
//
// It is not part of the app and is never deployed, but it is the only code in
// this repo that DELETES the operator's data, and it is run by hand against a
// real spreadsheet with no undo. So the file is loaded from disk and run
// unmodified against a fake SpreadsheetApp, exactly as test-apps-script.mjs
// does for Code.gs.
//
// Run with: node scripts/test-reset.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESET_PATH = join(ROOT, 'apps-script', 'Reset.gs');

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

/** A spreadsheet holding two drafts plus tabs the operator added themselves. */
function spreadsheetWith(names) {
  const sheets = new Map(names.map((n) => [n, { getName: () => n }]));
  return {
    getName: () => 'Test Sheet',
    getSheets: () => [...sheets.values()],
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet(n) {
      const s = { getName: () => n };
      sheets.set(n, s);
      return s;
    },
    deleteSheet(sheet) {
      const n = sheet.getName();
      if (sheets.size === 1) throw new Error('cannot delete the only sheet');
      sheets.delete(n);
    },
    remaining: () => [...sheets.keys()],
  };
}

const KINDS = ['Rosters', 'Picks', 'Budgets', 'Config', 'Log', 'Backup'];
const tabsFor = (key) => KINDS.map((k) => `${key} ${k}`);

/**
 * Load Reset.gs with its top-level settings overridden, the way the operator
 * edits them by hand before running it.
 */
function loadReset(spreadsheet, { confirm = false, draftKeys = [], alsoIndex = true } = {}) {
  let source = readFileSync(RESET_PATH, 'utf8');
  const set = (name, value) => {
    const re = new RegExp(`^var ${name} = .*;$`, 'm');
    if (!re.test(source)) throw new Error(`Reset.gs no longer declares ${name}`);
    source = source.replace(re, `var ${name} = ${JSON.stringify(value)};`);
  };
  set('CONFIRM', confirm);
  set('DRAFT_KEYS', draftKeys);
  set('ALSO_DELETE_INDEX', alsoIndex);

  const logs = [];
  const globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => {} },
    Logger: { log: (m) => logs.push(String(m)) },
  };
  const factory = new Function(
    ...Object.keys(globals),
    `${source}\n;return { listDraftTabs: listDraftTabs, deleteDraftTabs: deleteDraftTabs,
       isDraftTab_: isDraftTab_, draftKeyOfTab_: draftKeyOfTab_ };`
  );
  return { ...factory(...Object.values(globals)), logs };
}

console.log('\nRecognising a draft tab');

test('the six real tab names are recognised', () => {
  const { isDraftTab_ } = loadReset(spreadsheetWith([]));
  for (const name of tabsFor('2026-08-24 Kurtz League x9a2')) {
    assert.ok(isDraftTab_(name), `should have matched: ${name}`);
  }
});

test('a draft with no name in its key still matches', () => {
  // draftKey() drops an empty slug, so "2026-08-18 fj95 Picks" is a real tab.
  const { isDraftTab_ } = loadReset(spreadsheetWith([]));
  assert.ok(isDraftTab_('2026-08-18 fj95 Picks'));
});

test('the operator’s own tabs are NOT matched', () => {
  // The scary failure: this script running on a spreadsheet that is not only
  // used for drafts. Requiring the leading date is what prevents it.
  const { isDraftTab_ } = loadReset(spreadsheetWith([]));
  for (const safe of [
    'Weekly Log',            // ends in a kind word
    'Config',                // is a kind word
    'Budgets',
    'Notes',
    'Drafts',                // the index, handled separately and deliberately
    'Keeper Picks',
    '2026 Season Log',       // a year, but not a full date
  ]) {
    assert.ok(!isDraftTab_(safe), `must not have matched: ${safe}`);
  }
});

test('the draft key is recovered from a tab name', () => {
  const { draftKeyOfTab_ } = loadReset(spreadsheetWith([]));
  assert.equal(draftKeyOfTab_('2026-08-24 Kurtz League x9a2 Picks'), '2026-08-24 Kurtz League x9a2');
  assert.equal(draftKeyOfTab_('Weekly Log'), '');
});

console.log('\nThe dry run changes nothing');

test('listDraftTabs deletes nothing and says what it would do', () => {
  const names = [...tabsFor('2026-08-18 fj95'), 'Drafts', 'Notes'];
  const ss = spreadsheetWith(names);
  const { listDraftTabs, logs } = loadReset(ss, { confirm: true });

  const report = listDraftTabs();
  assert.deepEqual(ss.remaining(), names, 'a dry run must not touch the spreadsheet');
  assert.match(report, /WOULD DELETE \(7\)/);
  assert.match(report, /2026-08-18 fj95 {2}\(6 tabs\)/);
  assert.match(report, /WOULD KEEP \(1\)/);
  assert.ok(logs.length > 0, 'the report should reach the execution log');
});

console.log('\nDeleting');

test('it refuses while CONFIRM is false', () => {
  const names = [...tabsFor('2026-08-18 fj95'), 'Drafts'];
  const ss = spreadsheetWith(names);
  const { deleteDraftTabs } = loadReset(ss, { confirm: false });

  assert.match(deleteDraftTabs(), /Refusing to delete anything/);
  assert.deepEqual(ss.remaining(), names, 'nothing may be deleted without CONFIRM');
});

test('with CONFIRM it removes every draft tab and the index', () => {
  const ss = spreadsheetWith([
    ...tabsFor('2026-08-18 fj95'),
    ...tabsFor('2026-08-24 Kurtz League x9a2'),
    'Drafts',
    'Notes',
  ]);
  const { deleteDraftTabs } = loadReset(ss, { confirm: true });
  deleteDraftTabs();
  assert.deepEqual(ss.remaining(), ['Notes'], 'only the operator’s own tab should survive');
});

test('unrelated tabs survive even when they look like draft tabs', () => {
  const ss = spreadsheetWith([...tabsFor('2026-08-18 fj95'), 'Weekly Log', 'Config', 'Keeper Picks']);
  const { deleteDraftTabs } = loadReset(ss, { confirm: true, alsoIndex: false });
  deleteDraftTabs();
  assert.deepEqual(ss.remaining().sort(), ['Config', 'Keeper Picks', 'Weekly Log']);
});

test('naming specific drafts leaves the others alone', () => {
  const ss = spreadsheetWith([
    ...tabsFor('2026-08-18 fj95'),
    ...tabsFor('2026-08-24 Real Draft x9a2'),
    'Drafts',
  ]);
  const { deleteDraftTabs } = loadReset(ss, { confirm: true, draftKeys: ['2026-08-18 fj95'] });
  deleteDraftTabs();
  assert.deepEqual(
    ss.remaining().sort(),
    [...tabsFor('2026-08-24 Real Draft x9a2'), 'Drafts'].sort(),
    'the draft that was not named must be untouched, index included'
  );
});

test('the index survives when ALSO_DELETE_INDEX is false', () => {
  const ss = spreadsheetWith([...tabsFor('2026-08-18 fj95'), 'Drafts']);
  const { deleteDraftTabs } = loadReset(ss, { confirm: true, alsoIndex: false });
  deleteDraftTabs();
  assert.deepEqual(ss.remaining(), ['Drafts']);
});

test('clearing everything leaves a blank sheet, because Google demands one', () => {
  const ss = spreadsheetWith([...tabsFor('2026-08-18 fj95'), 'Drafts']);
  const { deleteDraftTabs } = loadReset(ss, { confirm: true });
  const summary = deleteDraftTabs();
  assert.deepEqual(ss.remaining(), ['Sheet1']);
  assert.match(summary, /cannot have none/);
});

test('an empty spreadsheet is a no-op, not an error', () => {
  const ss = spreadsheetWith(['Notes']);
  const { deleteDraftTabs } = loadReset(ss, { confirm: true });
  assert.equal(deleteDraftTabs(), 'nothing to do');
  assert.deepEqual(ss.remaining(), ['Notes']);
});

console.log('\nSafe by default');

test('the file on disk ships with CONFIRM off', () => {
  // It is run by hand from an editor, where the wrong function is one click
  // away. Committing it armed would be a genuinely bad idea.
  const src = readFileSync(RESET_PATH, 'utf8');
  assert.match(src, /^var CONFIRM = false;$/m, 'CONFIRM must be committed as false');
  assert.match(src, /^var DRAFT_KEYS = \[\];$/m);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
