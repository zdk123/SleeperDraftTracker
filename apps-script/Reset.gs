/**
 * Draft Board -- one-off cleanup for a spreadsheet full of test drafts.
 *
 * NOT part of the app. Nothing in the draft board calls this, and adding it to
 * your Apps Script project does not expose it to anyone: a web app deployment
 * only ever reaches doGet and doPost, so these functions are reachable only by
 * you, from the editor. Delete the file again when you're done if you'd rather
 * not have it lying around.
 *
 * HOW TO USE
 *   1. Apps Script editor -> + (next to Files) -> Script -> name it "Reset".
 *   2. Paste this in and save.
 *   3. Pick `listDraftTabs` from the function dropdown and click Run. It writes
 *      a report to the execution log and changes NOTHING.
 *   4. Read that report. If you're happy, set CONFIRM to true below, save,
 *      then run `deleteDraftTabs`.
 *   5. Set CONFIRM back to false afterwards.
 *
 * You do NOT need to re-deploy anything. Deployments only matter for the code
 * the web app serves; this is run by hand.
 */

// Deliberately false. Deleting spreadsheet tabs cannot be undone from a script,
// and the whole point of this file is that it's easy to run by accident.
var CONFIRM = false;

// Empty means "every draft in this spreadsheet". To remove only some, list
// their keys exactly as they appear in the tab names, e.g.
//   var DRAFT_KEYS = ['2026-08-18 fj95', '2026-08-24 Kurtz League x9a2'];
var DRAFT_KEYS = [];

// Whether to also remove the shared index tab that lists every draft. The app
// recreates it on the next save, so true gives a genuinely blank spreadsheet.
var ALSO_DELETE_INDEX = true;

var RESET_INDEX_TAB = 'Drafts';
var RESET_KINDS = ['Rosters', 'Picks', 'Budgets', 'Config', 'Log', 'Backup'];

/**
 * A draft tab is "<draftKey> <Kind>", and every draftKey starts with the date
 * the draft was created. Requiring that date is what stops this deleting a tab
 * of your own that happens to end in a word like "Log".
 */
function isDraftTab_(name) {
  var kinds = RESET_KINDS.join('|');
  return new RegExp('^\\d{4}-\\d{2}-\\d{2} .*\\s(' + kinds + ')$').test(name);
}

/** The draft key a tab belongs to, or '' if it isn't a draft tab. */
function draftKeyOfTab_(name) {
  if (!isDraftTab_(name)) return '';
  return name.replace(new RegExp('\\s(' + RESET_KINDS.join('|') + ')$'), '');
}

function targetsIn_(ss) {
  var wanted = {};
  for (var i = 0; i < DRAFT_KEYS.length; i++) wanted[DRAFT_KEYS[i]] = true;
  var limit = DRAFT_KEYS.length > 0;

  var doomed = [];
  var kept = [];
  var sheets = ss.getSheets();

  for (var s = 0; s < sheets.length; s++) {
    var name = sheets[s].getName();
    var key = draftKeyOfTab_(name);

    if (key && (!limit || wanted[key])) doomed.push(name);
    else if (name === RESET_INDEX_TAB && ALSO_DELETE_INDEX && !limit) doomed.push(name);
    else kept.push(name);
  }
  return { doomed: doomed, kept: kept, total: sheets.length };
}

/** Report only. Run this first; it never changes anything. */
function listDraftTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plan = targetsIn_(ss);

  var keys = {};
  for (var i = 0; i < plan.doomed.length; i++) {
    var k = draftKeyOfTab_(plan.doomed[i]);
    if (k) keys[k] = (keys[k] || 0) + 1;
  }

  var lines = [];
  lines.push('Spreadsheet: ' + ss.getName());
  lines.push(plan.total + ' tabs in total.');
  lines.push('');
  lines.push('WOULD DELETE (' + plan.doomed.length + '):');
  for (var d = 0; d < plan.doomed.length; d++) lines.push('   - ' + plan.doomed[d]);
  lines.push('');
  lines.push('drafts affected:');
  for (var key in keys) lines.push('   ' + key + '  (' + keys[key] + ' tabs)');
  lines.push('');
  lines.push('WOULD KEEP (' + plan.kept.length + '):');
  for (var p = 0; p < plan.kept.length; p++) lines.push('   - ' + plan.kept[p]);
  lines.push('');
  lines.push(
    CONFIRM
      ? '>>> CONFIRM is true. Running deleteDraftTabs WILL delete the above.'
      : '>>> CONFIRM is false, so deleteDraftTabs would refuse. Set it to true when ready.'
  );

  var report = lines.join('\n');
  Logger.log(report);
  return report;
}

/** Does it. Refuses unless CONFIRM has been set to true by hand. */
function deleteDraftTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!CONFIRM) {
    var refusal =
      'Refusing to delete anything: CONFIRM is false.\n' +
      'Run listDraftTabs first, read the report, then set CONFIRM = true at the top of this file.';
    Logger.log(refusal);
    return refusal;
  }

  var plan = targetsIn_(ss);
  if (!plan.doomed.length) {
    Logger.log('Nothing matched. The spreadsheet has no draft tabs to remove.');
    return 'nothing to do';
  }

  // A spreadsheet must always keep at least one sheet, so if this would empty
  // it completely, put a blank one in first rather than failing halfway.
  var placeholder = null;
  if (!plan.kept.length) placeholder = ss.insertSheet('Sheet1');

  var deleted = [];
  var failed = [];
  for (var i = 0; i < plan.doomed.length; i++) {
    var sheet = ss.getSheetByName(plan.doomed[i]);
    if (!sheet) continue;
    try {
      ss.deleteSheet(sheet);
      deleted.push(plan.doomed[i]);
    } catch (err) {
      failed.push(plan.doomed[i] + ' (' + err.message + ')');
    }
  }

  SpreadsheetApp.flush();

  var summary =
    'Deleted ' + deleted.length + ' tab(s).' +
    (placeholder ? '\nAdded an empty "Sheet1" because a spreadsheet cannot have none.' : '') +
    (failed.length ? '\nFAILED:\n   - ' + failed.join('\n   - ') : '') +
    '\n\nSet CONFIRM back to false now.';
  Logger.log(summary);
  return summary;
}
