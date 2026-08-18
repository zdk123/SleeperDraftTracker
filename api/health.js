import { sendJson, methodGuard } from './_lib/http.js';
import { isConfigured } from './_lib/auth.js';
import { TABS, ALL_TABS } from './_lib/schema.js';
import { ensureTabs, getValues, batchUpdateValues } from './_lib/sheets.js';

// A real read+write round-trip against the sheet, surfaced as the setup
// screen's "Test connection" button. The point is to fail loudly days before
// draft night rather than silently on it.

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const started = Date.now();
  const result = {
    ok: false,
    hasCredentials: isConfigured(),
    requiresToken: Boolean(process.env.APP_WRITE_TOKEN),
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID ? 'set' : null,
    serviceAccount: process.env.GOOGLE_SA_EMAIL || null,
    canRead: false,
    canWrite: false,
    sheetTitle: null,
    createdTabs: [],
    latencyMs: 0,
  };

  if (!result.hasCredentials) {
    result.mode = 'offline-only';
    result.message =
      'No Google credentials configured. The app still works and saves locally in this ' +
      'browser, but nothing syncs to a spreadsheet.';
    result.latencyMs = Date.now() - started;
    return sendJson(res, 200, result);
  }

  try {
    const { title, created } = await ensureTabs(ALL_TABS);
    result.sheetTitle = title;
    result.createdTabs = created;

    await getValues(`${TABS.CONFIG}!A1:B1`);
    result.canRead = true;

    await batchUpdateValues([
      { range: `${TABS.LOG}!I1`, values: [[`health check ${new Date().toISOString()}`]] },
    ]);
    result.canWrite = true;

    result.ok = true;
    result.mode = 'synced';
    result.message = `Connected to "${title}".`;
  } catch (err) {
    result.mode = 'error';
    result.errorCode = err.code || 'unknown';
    result.message = err.message;
    if (err.hint) result.hint = err.hint;
  }

  result.latencyMs = Date.now() - started;
  return sendJson(res, 200, result);
}
