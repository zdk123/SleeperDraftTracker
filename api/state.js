import { sendJson, sendError, methodGuard, query } from './_lib/http.js';
import { requireToken, isConfigured } from './_lib/auth.js';
import {
  INDEX_RANGE,
  configReadRange,
  picksReadRange,
  backupReadRange,
  rowsToState,
  parseConfigHead,
  parseIndex,
} from './_lib/schema.js';
import { getValues, batchGetValues } from './_lib/sheets.js';

// Disaster recovery: list what the spreadsheet holds, and rebuild any one of
// those drafts when the operator's browser storage is gone (cleared data,
// different laptop, crash).
//
//   GET /api/state                 -> the list of drafts
//   GET /api/state?draft=<key>     -> rebuild that one

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  if (!requireToken(req, res)) return;

  if (!isConfigured()) {
    return sendError(
      res,
      503,
      'not_configured',
      'Sheets sync is not configured on this server, so there is nothing to restore from.'
    );
  }

  const wanted = query(req).get('draft');

  try {
    const drafts = parseIndex(await getValues(INDEX_RANGE).catch(() => []));

    if (!wanted) {
      return sendJson(res, 200, { ok: true, drafts });
    }

    const known = drafts.find((d) => d.draftKey === wanted);
    const ranges = [configReadRange(wanted), picksReadRange(wanted), backupReadRange(wanted)];
    const values = await batchGetValues(ranges).catch(() => null);

    if (!values) {
      return sendJson(res, 200, { ok: true, found: false, drafts, state: null });
    }

    const configRows = values[ranges[0]];
    const head = parseConfigHead(configRows);
    if (!head.draftId) {
      return sendJson(res, 200, { ok: true, found: false, drafts, state: null });
    }

    const state = rowsToState({
      configRows,
      pickRows: values[ranges[1]],
      backupRows: values[ranges[2]],
    });

    return sendJson(res, 200, {
      ok: true,
      found: true,
      draftKey: wanted,
      name: head.name || known?.name || '',
      revision: head.revision,
      updatedAt: head.updatedAt,
      drafts,
      state,
    });
  } catch (err) {
    const status = err.code === 'quota_exceeded' ? 429 : err.status || 502;
    return sendError(res, status, err.code || 'sheets_error', err.message, {
      ...(err.hint ? { hint: err.hint } : {}),
    });
  }
}
