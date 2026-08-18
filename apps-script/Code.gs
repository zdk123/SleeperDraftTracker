/**
 * Draft Board -- Google Apps Script backend.
 *
 * This is the no-GCP way to get the draft into a spreadsheet. Paste this file
 * into the sheet's own Apps Script editor and deploy it as a web app; the
 * script runs as you, on your sheet, so there is no service account, no key
 * file, and no cloud project to create. See README.md.
 *
 * The browser sends finished spreadsheet rows -- this script deliberately knows
 * nothing about auctions, budgets, or rosters. All of that mapping lives in one
 * place, public/js/schema.js, so this file cannot drift away from it.
 *
 * Its only real jobs are the two guards that stop good data being replaced by
 * bad: refusing a write from a different draft, and refusing an older revision
 * of the same draft.
 */

// Paste the same long random string you put in the app's "Access token" box.
// Leave it empty only if you are fine with anyone who learns the deployment URL
// being able to write to this spreadsheet.
var WRITE_TOKEN = '';

var INDEX_TAB = 'Drafts';
var LOCK_WAIT_MS = 20000;

// The app treats 409 as "stop and ask the operator" and anything else as
// "retry later", so getting these right is what stops a conflict being retried
// forever -- or worse, being reported as success.
var ERROR_STATUS = {
  unauthorized: 401,
  bad_request: 400,
  bad_state: 400,
  different_draft: 409,
  stale: 409,
  busy: 503,
  script_error: 500
};

function statusOf(payload) {
  if (payload.ok) return 200;
  return ERROR_STATUS[payload.error && payload.error.code] || 500;
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (WRITE_TOKEN && body.token !== WRITE_TOKEN) {
      return reply(401, { ok: false, error: { code: 'unauthorized', message: 'Bad access token.' } });
    }

    var out;
    switch (body.op) {
      case 'health':
        out = health_();
        return reply(out.ok ? 200 : 502, out);
      case 'sync':
        out = sync_(body);
        return reply(statusOf(out), out);
      case 'list': return reply(200, list_());
      case 'load': return reply(200, load_(body));
      default:
        return reply(400, {
          ok: false,
          error: { code: 'bad_request', message: 'Unknown op: ' + body.op }
        });
    }
  } catch (err) {
    return reply(500, {
      ok: false,
      error: { code: 'script_error', message: String((err && err.message) || err) }
    });
  }
}

/**
 * A GET is what you land on if you paste the deployment URL into a browser,
 * so make it say something useful rather than throwing.
 */
function doGet() {
  return reply(200, {
    ok: true,
    service: 'draft-board-apps-script',
    message: 'This URL is working. Paste it into the draft app’s setup screen.',
    spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName()
  });
}

/**
 * Apps Script cannot set response headers, so the status code travels in the
 * body. Responses are text/plain: that keeps the browser's POST a "simple
 * request" with no CORS preflight, which Apps Script would not answer.
 */
function reply(status, payload) {
  payload.status = status;
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function health_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var started = Date.now();
  var sheet = tab_(ss, INDEX_TAB);
  var stamp = new Date().toISOString();
  sheet.getRange('L1').setValue(stamp);          // a real write, not just a read
  var ok = String(sheet.getRange('L1').getValue()).indexOf(stamp.slice(0, 19)) === 0;
  return {
    ok: ok,
    backend: 'apps-script',
    hasCredentials: true,   // the script *is* the credential; it runs as its deployer
    message: ok
      ? 'Connected to “' + ss.getName() + '” and wrote to it successfully.'
      : 'Reached the script, but the test write did not read back.',
    hint: ok ? '' : 'Check the deploying account can edit this spreadsheet.',
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    latencyMs: Date.now() - started,
    serverTime: stamp
  };
}

function sync_(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, error: { code: 'busy', message: 'Another write is in progress.' } };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var draftKey = body.draftKey;
    var draftId = body.draftId;
    var revision = Number(body.revision) || 0;
    if (!draftKey || !draftId) {
      return { ok: false, error: { code: 'bad_state', message: 'Missing draftKey or draftId.' } };
    }

    var head = configHead_(ss, draftKey);

    // These tabs belong to one draft, so anything else here is a key collision.
    if (head.draftId && head.draftId !== draftId && !body.force) {
      return {
        ok: false,
        error: {
          code: 'different_draft',
          message: 'These spreadsheet tabs are holding a different draft. Nothing was overwritten — ' +
                   'take them over deliberately if this is the draft you mean to keep.'
        },
        serverDraftId: head.draftId,
        serverDraftKey: head.draftKey || draftKey,
        serverRevision: head.revision,
        serverUpdatedAt: head.updatedAt
      };
    }

    // Older state for the same draft (a restored browser, a stale tab).
    if (head.draftId === draftId && revision <= head.revision && !body.force) {
      return {
        ok: false,
        error: {
          code: 'stale',
          message: 'The spreadsheet already holds a newer version of this draft. Nothing was overwritten.'
        },
        serverRevision: head.revision,
        serverUpdatedAt: head.updatedAt
      };
    }

    (body.ranges || []).forEach(function (r) {
      writeBlock_(ss, tabOf_(r.range), r.values);
    });

    if (body.indexRow) upsertIndex_(ss, body.indexRow);
    if (body.logRow) tab_(ss, draftKey + ' Log').appendRow(body.logRow);

    SpreadsheetApp.flush();
    return {
      ok: true,
      backend: 'apps-script',
      revision: revision,
      draftKey: draftKey,
      pickCount: Number(body.pickCount) || 0,
      serverTime: new Date().toISOString(),
      forced: Boolean(body.force)
    };
  } finally {
    lock.releaseLock();
  }
}

/** Every draft this spreadsheet holds, from the shared index tab. */
function list_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INDEX_TAB);
  return { ok: true, rows: sheet ? sheet.getDataRange().getValues() : [] };
}

/**
 * Raw rows for one draft. The browser turns these back into state with the
 * same rowsToState() the server uses, so both restore paths behave identically.
 */
function load_(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var key = body.draftKey;
  return {
    ok: true,
    configRows: rowsOf_(ss, key + ' Config'),
    pickRows: rowsOf_(ss, key + ' Picks'),
    backupRows: rowsOf_(ss, key + ' Backup')
  };
}

// --- sheet helpers -------------------------------------------------------

function rowsOf_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() === 0) return [];
  return sheet.getDataRange().getValues();
}

/** Get a tab, creating it if this is the first write. */
function tab_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** `'2026-08-24 League x9a2 Picks'!A1:L500` -> the tab name. */
function tabOf_(range) {
  var bang = range.lastIndexOf('!');
  var name = bang === -1 ? range : range.slice(0, bang);
  if (name.charAt(0) === "'" && name.charAt(name.length - 1) === "'") {
    name = name.slice(1, -1).replace(/''/g, "'");
  }
  return name;
}

/**
 * Write a padded block at A1. The blocks are fixed-size by design: a shrinking
 * pick count overwrites the rows it used to occupy with blanks rather than
 * leaving stale players behind on the roster sheet someone re-types into Sleeper.
 */
function writeBlock_(ss, name, values) {
  if (!values || !values.length) return;
  var sheet = tab_(ss, name);
  var rows = values.length;
  var cols = values[0].length;
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, rows, cols).setValues(values);
}

/** One row per draft in the shared index: replace in place, or append. */
function upsertIndex_(ss, row) {
  var sheet = tab_(ss, INDEX_TAB);
  var last = sheet.getLastRow();
  var keys = last > 0 ? sheet.getRange(1, 1, last, 1).getValues() : [];
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(row[0])) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  if (last === 0) {
    sheet.appendRow(['Draft', 'Name', 'Started', 'Last saved', 'Picks', 'Spent', 'Teams', 'Status', 'Draft ID']);
  }
  sheet.appendRow(row);
}

/**
 * draftId / revision / updatedAt out of a draft's Config tab, read directly
 * rather than through the shared schema -- this is the one piece of mapping
 * knowledge the script needs, and it is two columns wide.
 */
function configHead_(ss, draftKey) {
  var head = { draftId: '', draftKey: '', revision: 0, updatedAt: '' };
  var sheet = ss.getSheetByName(draftKey + ' Config');
  if (!sheet || sheet.getLastRow() === 0) return head;
  var rows = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 20), 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][0]);
    var value = rows[i][1];
    if (key === 'draftId') head.draftId = String(value || '');
    else if (key === 'draftKey') head.draftKey = String(value || '');
    else if (key === 'revision') head.revision = Number(value) || 0;
    else if (key === 'updatedAt') head.updatedAt = String(value || '');
    else if (key === 'Teams') break;
  }
  return head;
}
