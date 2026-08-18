import { sendJson, sendError, readJsonBody, methodGuard } from './_lib/http.js';
import { requireToken, isConfigured } from './_lib/auth.js';
import {
  TABS,
  ALL_TABS,
  CONFIG_READ_RANGE,
  stateToRanges,
  logRow,
  parseConfigHead,
} from './_lib/schema.js';
import { getValues, batchUpdateValues, appendValues, ensureTabs } from './_lib/sheets.js';

// Full-snapshot write: the client sends its entire state and we rewrite every
// derived tab. That makes undo/edit a non-problem (a deleted pick is simply
// absent from the next snapshot) and makes a dropped or reordered sync
// self-healing -- the next successful write reconciles the sheet exactly.
//
// This endpoint deliberately performs no budget or roster validation. Those
// guardrails are client-side and synchronous; a server-side rejection mid-draft
// would be unactionable for the operator and a source of divergence.

let tabsEnsured = false;

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!requireToken(req, res)) return;

  if (!isConfigured()) {
    return sendError(
      res,
      503,
      'not_configured',
      'Sheets sync is not configured on this server. The draft is safe in local storage.'
    );
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, 400, err.code || 'bad_request', err.message);
  }

  const state = body.state;
  if (!state || typeof state !== 'object' || !Array.isArray(state.picks)) {
    return sendError(res, 400, 'bad_state', 'Expected { state: { picks: [...] } }.');
  }
  if (!state.draftId) {
    return sendError(res, 400, 'bad_state', 'State is missing draftId.');
  }

  const revision = Number(state.revision) || 0;

  try {
    if (!tabsEnsured) {
      await ensureTabs(ALL_TABS);
      tabsEnsured = true;
    }

    // Stale-write guard: never let a client with older state clobber newer data
    // (a second tab, a restored-from-backup browser). Same draft only -- a new
    // draftId legitimately restarts the numbering.
    const head = parseConfigHead(await getValues(CONFIG_READ_RANGE));
    const sameDraft = head.draftId && head.draftId === state.draftId;
    if (sameDraft && revision <= head.revision && !body.force) {
      return sendJson(res, 409, {
        ok: false,
        error: {
          code: 'stale',
          message:
            'The spreadsheet already holds a newer version of this draft. Nothing was overwritten.',
        },
        serverRevision: head.revision,
        serverUpdatedAt: head.updatedAt,
      });
    }

    await batchUpdateValues(stateToRanges(state));
    await appendValues(`${TABS.LOG}!A1`, [
      logRow(state, { client: body.client || '', summary: body.summary || '' }),
    ]);

    return sendJson(res, 200, {
      ok: true,
      revision,
      pickCount: state.picks.length,
      serverTime: new Date().toISOString(),
      forced: Boolean(body.force),
    });
  } catch (err) {
    const status = err.code === 'quota_exceeded' ? 429 : err.status || 502;
    return sendError(res, status, err.code || 'sheets_error', err.message, {
      ...(err.hint ? { hint: err.hint } : {}),
    });
  }
}
