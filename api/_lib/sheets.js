import { getAccessToken } from './googleAuth.js';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

function spreadsheetId() {
  const id = process.env.SHEETS_SPREADSHEET_ID;
  if (!id) {
    const err = new Error('SHEETS_SPREADSHEET_ID is not set.');
    err.code = 'bad_credentials';
    throw err;
  }
  return id;
}

/**
 * A 403 from Sheets is ambiguous and the two cases need very different fixes,
 * so they get distinct codes: sharing the sheet with the service account vs.
 * backing off. Anything else keeps Google's own reason string.
 */
function apiError(status, payload) {
  const reason = payload?.error?.status || '';
  const message = payload?.error?.message || `Sheets API returned HTTP ${status}`;
  const err = new Error(message);
  err.status = status;

  if (status === 403 && /quota|rate/i.test(message)) {
    err.code = 'quota_exceeded';
  } else if (status === 403 || status === 404) {
    err.code = 'sheet_not_shared';
    err.hint =
      'Share the spreadsheet with the service account email as an Editor, and check ' +
      'that SHEETS_SPREADSHEET_ID matches the sheet URL.';
  } else if (status === 429) {
    err.code = 'quota_exceeded';
  } else {
    err.code = reason ? reason.toLowerCase() : 'sheets_error';
  }
  return err;
}

async function call(path, { method = 'GET', body, params } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${BASE}/${spreadsheetId()}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else if (value !== undefined) url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res.status, payload);
  return payload;
}

export async function getValues(range) {
  const data = await call(`/values/${encodeURIComponent(range)}`, {
    params: { majorDimension: 'ROWS' },
  });
  return data.values || [];
}

export async function batchGetValues(ranges) {
  const data = await call('/values:batchGet', {
    params: { ranges, majorDimension: 'ROWS' },
  });
  const out = {};
  (data.valueRanges || []).forEach((vr, i) => {
    out[ranges[i]] = vr.values || [];
  });
  return out;
}

/** Overwrites each range with the supplied rows in a single request. */
export async function batchUpdateValues(entries) {
  return call('/values:batchUpdate', {
    method: 'POST',
    body: {
      valueInputOption: 'RAW',
      data: entries.map(({ range, values }) => ({ range, majorDimension: 'ROWS', values })),
    },
  });
}

export async function appendValues(range, values) {
  return call(`/values/${encodeURIComponent(range)}:append`, {
    method: 'POST',
    params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    body: { majorDimension: 'ROWS', values },
  });
}

export async function getSpreadsheetMeta() {
  return call('', { params: { fields: 'properties.title,sheets.properties.title' } });
}

/** Creates any of the given tab titles that don't already exist. */
export async function ensureTabs(titles) {
  const meta = await getSpreadsheetMeta();
  const existing = new Set((meta.sheets || []).map((s) => s.properties.title));
  const missing = titles.filter((t) => !existing.has(t));
  if (missing.length) {
    await call(':batchUpdate', {
      method: 'POST',
      body: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }
  return { title: meta.properties?.title || '', created: missing };
}
