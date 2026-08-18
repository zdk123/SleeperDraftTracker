import { sendJson, sendError, readJsonBody, methodGuard } from './_lib/http.js';
import { requireToken, isConfigured } from './_lib/auth.js';
import {
  INDEX_TAB,
  INDEX_RANGE,
  draftKeyOf,
  tabsFor,
  stateToRanges,
  logRow,
  logAppendRange,
  configReadRange,
  indexRowsWith,
  parseConfigHead,
} from './_lib/schema.js';
import { getValues, batchUpdateValues, appendValues, ensureTabs } from './_lib/sheets.js';

// Full-snapshot write: the client sends its entire state and we rewrite every
// derived tab for that draft. That makes undo/edit a non-problem (a deleted
// pick is simply absent from the next snapshot) and makes a dropped or
// reordered sync self-healing -- the next successful write reconciles the
// sheet exactly.
//
// Every draft owns a distinct set of tabs, named after its key, so two drafts
// sharing one spreadsheet cannot overwrite each other.
//
// This endpoint deliberately performs no budget or roster validation. Those
// guardrails are client-side and synchronous; a server-side rejection mid-draft
// would be unactionable for the operator and a source of divergence.

const ensuredTabs = new Set();

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

  const draftKey = draftKeyOf(state);
  const revision = Number(state.revision) || 0;

  try {
    if (!ensuredTabs.has(draftKey)) {
      await ensureTabs([INDEX_TAB, ...tabsFor(draftKey)]);
      ensuredTabs.add(draftKey);
    }

    const head = parseConfigHead(await getValues(configReadRange(draftKey)));

    // These tabs belong to one draft, so anything else appearing here means a
    // key collision -- refuse rather than replace someone else's data.
    if (head.draftId && head.draftId !== state.draftId && !body.force) {
      return sendJson(res, 409, {
        ok: false,
        error: {
          code: 'different_draft',
          message:
            'These spreadsheet tabs are holding a different draft. Nothing was overwritten — ' +
            'take them over deliberately if this is the draft you mean to keep.',
        },
        serverDraftId: head.draftId,
        serverDraftKey: head.draftKey || draftKey,
        serverRevision: head.revision,
        serverUpdatedAt: head.updatedAt,
      });
    }

    // Older state for the same draft (a restored browser, a stale tab).
    if (head.draftId === state.draftId && revision <= head.revision && !body.force) {
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

    // Keep the shared index in step with this draft's own tabs.
    const existingIndex = await getValues(INDEX_RANGE).catch(() => []);

    await batchUpdateValues([
      ...stateToRanges(state),
      { range: INDEX_RANGE, values: indexRowsWith(existingIndex, state) },
    ]);

    await appendValues(logAppendRange(draftKey), [
      logRow(state, { client: body.client || '', summary: body.summary || '' }),
    ]);

    return sendJson(res, 200, {
      ok: true,
      revision,
      draftKey,
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
