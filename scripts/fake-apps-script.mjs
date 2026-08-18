#!/usr/bin/env node
// Runs the real apps-script/Code.gs in Node against an in-memory spreadsheet.
//
// The point is that Code.gs itself is the thing under test -- it is loaded from
// disk and evaluated unmodified, so a bug in the deployed script is a failing
// test here. Only Google's own APIs are faked, and only the handful of calls
// Code.gs actually makes.
//
// Used by scripts/test-apps-script.mjs and scripts/simulate.mjs.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_PATH = join(ROOT, 'apps-script', 'Code.gs');

/** `L1` / `B12` -> { row, col } (1-indexed). */
function parseA1(a1) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(a1).trim().toUpperCase());
  if (!m) throw new Error(`fake sheet: unsupported A1 range ${a1}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = []; // sparse array of arrays
    this.maxRows = 1000;
    this.maxCols = 26;
    // The furthest cell ever written, blank or not. getLastRow() ignores
    // trailing blanks, which would hide exactly the failure the simulation
    // looks for: a shrinking draft leaving a deleted player on the sheet.
    this.touchedRows = 0;
    this.touchedCols = 0;
  }

  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }

  insertRowsAfter(_after, count) { this.maxRows += count; }
  insertColumnsAfter(_after, count) { this.maxCols += count; }

  /** Last row holding anything non-empty, matching Sheets' own definition. */
  getLastRow() {
    let last = 0;
    this.cells.forEach((row, i) => {
      if (row && row.some((v) => v !== '' && v !== null && v !== undefined)) last = i + 1;
    });
    return last;
  }

  getLastColumn() {
    let last = 0;
    for (const row of this.cells) {
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c -= 1) {
        if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
          last = Math.max(last, c + 1);
          break;
        }
      }
    }
    return last;
  }

  read(row, col) {
    const r = this.cells[row - 1];
    const v = r ? r[col - 1] : undefined;
    return v === undefined || v === null ? '' : v;
  }

  write(row, col, value) {
    if (row > this.maxRows || col > this.maxCols) {
      throw new Error(
        `fake sheet: write outside the grid (${this.name} r${row}c${col}, ` +
          `grid is ${this.maxRows}x${this.maxCols}) -- real Sheets throws here too`
      );
    }
    if (!this.cells[row - 1]) this.cells[row - 1] = [];
    this.cells[row - 1][col - 1] = value;
    this.touchedRows = Math.max(this.touchedRows, row);
    this.touchedCols = Math.max(this.touchedCols, col);
  }

  /** Every cell ever written, trailing blanks included. Test-only. */
  getWrittenValues() {
    if (!this.touchedRows) return [];
    return new FakeRange(this, 1, 1, this.touchedRows, this.touchedCols).getValues();
  }

  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const { row, col } = parseA1(a);
      return new FakeRange(this, row, col, 1, 1);
    }
    return new FakeRange(this, a, b, c, d);
  }

  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }

  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this.write(row, i + 1, v));
  }
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getValue() { return this.sheet.read(this.row, this.col); }

  setValue(v) { this.sheet.write(this.row, this.col, v); return this; }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const row = [];
      for (let c = 0; c < this.numCols; c += 1) row.push(this.sheet.read(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }

  setValues(values) {
    if (values.length !== this.numRows) {
      throw new Error(`fake sheet: expected ${this.numRows} rows, got ${values.length}`);
    }
    values.forEach((row, r) => {
      if (row.length !== this.numCols) {
        throw new Error(`fake sheet: expected ${this.numCols} columns, got ${row.length}`);
      }
      row.forEach((v, c) => this.sheet.write(this.row + r, this.col + c, v));
    });
    return this;
  }
}

class FakeSpreadsheet {
  constructor(name = 'Test Draft Sheet') {
    this.name = name;
    this.sheets = new Map();
  }

  getName() { return this.name; }
  getId() { return 'fake-spreadsheet-id'; }
  getSheetByName(name) { return this.sheets.get(name) || null; }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }

  /** Insertion order, which is what the real API returns. */
  getSheets() {
    return [...this.sheets.values()];
  }

  deleteSheet(sheet) {
    const name = typeof sheet === 'string' ? sheet : sheet.getName();
    if (!this.sheets.has(name)) throw new Error(`no such sheet: ${name}`);
    // Google refuses to leave a spreadsheet with no sheets at all.
    if (this.sheets.size === 1) throw new Error('cannot delete the only sheet');
    this.sheets.delete(name);
  }

  /** Test-only view: every tab as plain rows, including trailing blanks. */
  dump() {
    const out = {};
    for (const [name, sheet] of this.sheets) out[name] = sheet.getWrittenValues();
    return out;
  }
}

/**
 * Set one of Code.gs's top-level token vars, the way the operator does by hand.
 *
 * Throws rather than no-oping if the declaration isn't found. A silent miss here
 * would leave both tokens empty, which Code.gs reads as "open sheet" -- and then
 * every authorization test would pass without testing anything at all.
 */
function substituteVar(source, name, value) {
  const pattern = new RegExp(`^var ${name} = '';$`, 'm');
  if (!pattern.test(source)) {
    throw new Error(
      `Could not find "var ${name} = '';" in Code.gs. If it was renamed or given ` +
        'a default, update fake-apps-script.mjs -- otherwise the auth tests silently ' +
        'run against an open sheet.'
    );
  }
  return source.replace(pattern, `var ${name} = ${JSON.stringify(value)};`);
}

/**
 * Evaluate Code.gs with fake Google globals. Returns its doPost/doGet plus the
 * spreadsheet they operate on.
 */
export function loadAppsScript({ writeToken = '', viewToken = '', spreadsheetName } = {}) {
  const spreadsheet = new FakeSpreadsheet(spreadsheetName);
  let locked = false;

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush: () => {},
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        setMimeType() { return this; },
        getContent() { return this.text; },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (locked) return false;
          locked = true;
          return true;
        },
        releaseLock: () => { locked = false; },
      }),
    },
  };

  let source = readFileSync(CODE_PATH, 'utf8');
  // The operator pastes their tokens into the script; simulate those edits.
  // Both must be substituted independently: the security tests turn on cases
  // where one is set and the other is not.
  source = substituteVar(source, 'WRITE_TOKEN', writeToken);
  source = substituteVar(source, 'VIEW_TOKEN', viewToken);

  const factory = new Function(
    ...Object.keys(globals),
    `${source}\n;return { doPost: doPost, doGet: doGet };`
  );
  const { doPost, doGet } = factory(...Object.values(globals));

  /** Call doPost the way the deployed web app would, and parse the reply. */
  const post = (payload) =>
    JSON.parse(doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());

  return { spreadsheet, doPost, doGet, post };
}

/**
 * Serve the script over HTTP so a real browser can POST to it, exactly as it
 * would to a script.google.com deployment.
 */
export async function startFakeAppsScript({ port = 0, writeToken = '', viewToken = '' } = {}) {
  const script = loadAppsScript({ writeToken, viewToken });
  const requests = [];

  const state = { offline: false };

  const server = createServer((req, res) => {
    // Apps Script deployments answer any origin; that is what makes them usable
    // from file:// and from a Vercel page alike.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (state.offline) {
      res.socket.destroy(); // as if the venue's wifi had gone
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(script.doGet().getContent());
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let out;
      try {
        const payload = JSON.parse(body || '{}');
        requests.push(payload.op || 'unknown');
        out = script.doPost({ postData: { contents: body } }).getContent();
      } catch (err) {
        out = JSON.stringify({ ok: false, status: 500, error: { code: 'harness', message: String(err) } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    ...script,
    requests,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/exec`,
    /** Simulate the venue's wifi dropping: connections are refused outright. */
    setOffline(value) { state.offline = Boolean(value); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
