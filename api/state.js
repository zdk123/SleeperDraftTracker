import { sendJson, sendError, methodGuard } from './_lib/http.js';
import { requireToken, isConfigured } from './_lib/auth.js';
import {
  TABS,
  CONFIG_READ_RANGE,
  BACKUP_READ_RANGE,
  rowsToState,
  parseConfigHead,
} from './_lib/schema.js';
import { batchGetValues } from './_lib/sheets.js';

// Disaster recovery: rebuild the full draft from the spreadsheet when the
// operator's browser storage is gone (cleared data, different laptop, crash).

const PICKS_READ_RANGE = `${TABS.PICKS}!A1:L500`;

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

  try {
    const ranges = await batchGetValues([CONFIG_READ_RANGE, PICKS_READ_RANGE, BACKUP_READ_RANGE]);
    const configRows = ranges[CONFIG_READ_RANGE];
    const head = parseConfigHead(configRows);

    if (!head.draftId) {
      return sendJson(res, 200, { ok: true, found: false, state: null });
    }

    const state = rowsToState({
      configRows,
      pickRows: ranges[PICKS_READ_RANGE],
      backupRows: ranges[BACKUP_READ_RANGE],
    });

    return sendJson(res, 200, {
      ok: true,
      found: true,
      revision: head.revision,
      updatedAt: head.updatedAt,
      state,
    });
  } catch (err) {
    const status = err.code === 'quota_exceeded' ? 429 : err.status || 502;
    return sendError(res, status, err.code || 'sheets_error', err.message, {
      ...(err.hint ? { hint: err.hint } : {}),
    });
  }
}
