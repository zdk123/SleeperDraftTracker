// Shared definition of how draft state maps onto the spreadsheet. Both
// api/sync.js (state -> rows) and api/state.js (rows -> state) use this, so the
// two directions can't drift apart.

// Each draft gets its own set of tabs, named after its key. Two drafts in one
// spreadsheet therefore cannot touch each other's data at all -- the isolation
// is structural rather than a guard that has to hold.
export const TAB_KINDS = {
  ROSTERS: 'Rosters',
  PICKS: 'Picks',
  BUDGETS: 'Budgets',
  CONFIG: 'Config',
  LOG: 'Log',
  BACKUP: 'Backup',
};

/** One shared tab listing every draft in the spreadsheet. */
export const INDEX_TAB = 'Drafts';

export const INDEX_HEADERS = [
  'Draft',
  'Name',
  'Started',
  'Last saved',
  'Picks',
  'Spent',
  'Teams',
  'Status',
  'Draft ID',
];

/** Tab name for one kind of data belonging to one draft. */
export function tabName(draftKey, kind) {
  return `${draftKey} ${kind}`;
}

export function tabsFor(draftKey) {
  return Object.values(TAB_KINDS).map((kind) => tabName(draftKey, kind));
}

/**
 * A1 ranges must quote tab names containing spaces, which every draft tab has.
 * Apostrophes inside a name are escaped by doubling them.
 */
export function quoteTab(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function range(draftKey, kind, span) {
  return `${quoteTab(tabName(draftKey, kind))}!${span}`;
}

// Every rewrite clears a fixed range, so a shrinking pick count (after a
// delete) can't leave stale trailing rows behind in the derived tabs. These
// are generous upper bounds, not expectations.
const MAX_PICK_ROWS = 500;
const MAX_ROSTER_ROWS = 80;
const MAX_TEAM_ROWS = 40;
const MAX_CONFIG_ROWS = 120;
const MAX_BACKUP_ROWS = 40;
const MAX_TEAM_COLS = 24;

const BACKUP_CHUNK_CHARS = 40000; // Sheets caps a cell at ~50k characters.

const PICK_HEADERS = [
  'Pick #',
  'Timestamp',
  'Player',
  'Pos',
  'NFL Team',
  'Sleeper Player ID',
  'Fantasy Team',
  'Manager',
  'Price',
  'Slot',
  'Overridden?',
  'Notes',
];

const BUDGET_HEADERS = [
  'Fantasy Team',
  'Manager',
  'Budget',
  'Spent',
  'Remaining',
  'Slots Filled',
  'Slots Open',
  'Max Bid',
];

export const LOG_HEADERS = [
  'Timestamp',
  'Revision',
  'Client',
  'Op Summary',
  'Pick Count',
  'Total Spent',
  'Detail (JSON)',
];

export const DEFAULT_ROSTER_SLOTS = [
  { slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] },
  { slotKey: 'RB', label: 'RB', count: 2, eligiblePositions: ['RB'] },
  { slotKey: 'WR', label: 'WR', count: 2, eligiblePositions: ['WR'] },
  { slotKey: 'TE', label: 'TE', count: 1, eligiblePositions: ['TE'] },
  { slotKey: 'FLEX', label: 'FLEX', count: 1, eligiblePositions: ['RB', 'WR', 'TE'] },
  { slotKey: 'DEF', label: 'DEF', count: 1, eligiblePositions: ['DEF'] },
  { slotKey: 'K', label: 'K', count: 1, eligiblePositions: ['K'] },
  { slotKey: 'BENCH', label: 'BN', count: 6, eligiblePositions: ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'] },
];

export const DEFAULT_SETTINGS = {
  budgetPerTeam: 200,
  // Sleeper's rule: minimum bid is $1, and a team must hold that much back for
  // every roster spot it still has to fill. One number drives both.
  minBid: 1,
  rosterSlots: DEFAULT_ROSTER_SLOTS,
  nominationStyle: 'rotating',
  sleeperLeagueId: null,
};

/** Tolerates state written before the setting was renamed. */
export function minBidOf(settings) {
  return Number(settings?.minBid ?? settings?.minReservePerOpenSlot ?? 1) || 0;
}

/** Expands `{slotKey:'RB', count:2}` into the concrete codes RB1, RB2. */
export function expandSlots(rosterSlots) {
  const out = [];
  for (const slot of rosterSlots || []) {
    const count = Math.max(0, Number(slot.count) || 0);
    for (let i = 1; i <= count; i += 1) {
      out.push({
        code: count === 1 ? slot.slotKey : `${slot.slotKey}${i}`,
        label: count === 1 ? slot.label : `${slot.label}${i}`,
        slotKey: slot.slotKey,
        eligiblePositions: slot.eligiblePositions || [],
      });
    }
  }
  return out;
}

export function totalSlotCount(rosterSlots) {
  return (rosterSlots || []).reduce((sum, s) => sum + (Number(s.count) || 0), 0);
}

/** Per-team spend/remaining/max-bid. The one place this arithmetic lives. */
export function teamSummary(state, teamId) {
  const settings = state.settings || DEFAULT_SETTINGS;
  const budget = Number(settings.budgetPerTeam) || 0;
  const reserve = minBidOf(settings);
  const slotTotal = totalSlotCount(settings.rosterSlots);
  const picks = (state.picks || []).filter((p) => p.teamId === teamId);
  const spent = picks.reduce((sum, p) => sum + (Number(p.price) || 0), 0);
  const remaining = budget - spent;
  const filled = picks.length;
  const open = Math.max(0, slotTotal - filled);
  // Keep enough back to put the reserve on every slot still to fill after this one.
  const maxBid = open === 0 ? 0 : Math.max(0, remaining - (open - 1) * reserve);
  return { budget, spent, remaining, filled, open, maxBid };
}

function pad(rows, maxRows, width) {
  const out = rows.slice(0, maxRows);
  const blank = new Array(width).fill('');
  while (out.length < maxRows) out.push(blank.slice());
  return out.map((row) => {
    const r = row.slice(0, width);
    while (r.length < width) r.push('');
    return r;
  });
}

function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function picksRows(state) {
  const teamsById = new Map((state.teams || []).map((t) => [t.id, t]));
  const rows = [PICK_HEADERS];
  (state.picks || []).forEach((pick, i) => {
    const team = teamsById.get(pick.teamId) || {};
    const overridden = [
      pick.overrides?.budget ? 'budget' : null,
      pick.overrides?.slot ? 'slot' : null,
    ]
      .filter(Boolean)
      .join('+');
    rows.push([
      i + 1,
      pick.timestamp || '',
      pick.playerName || '',
      pick.position || '',
      pick.nflTeam || '',
      pick.playerId || '',
      team.name || '',
      team.manager || '',
      Number(pick.price) || 0,
      pick.slot || '',
      overridden,
      pick.note || '',
    ]);
  });
  return pad(rows, MAX_PICK_ROWS, PICK_HEADERS.length);
}

function budgetsRows(state) {
  const rows = [BUDGET_HEADERS];
  for (const team of state.teams || []) {
    const s = teamSummary(state, team.id);
    rows.push([
      team.name || '',
      team.manager || '',
      s.budget,
      s.spent,
      s.remaining,
      s.filled,
      s.open,
      // Written as a static value, not a formula: full-range rewrites clobber formulas.
      s.maxBid,
    ]);
  }
  return pad(rows, MAX_TEAM_ROWS, BUDGET_HEADERS.length);
}

/**
 * The tab the commissioner actually reads from when re-entering results into
 * Sleeper afterward: one (player, $) column pair per team, rows = roster slots.
 */
function rostersRows(state) {
  const teams = state.teams || [];
  const slots = expandSlots((state.settings || DEFAULT_SETTINGS).rosterSlots);
  const width = 1 + teams.length * 2;

  const header = ['Slot'];
  for (const team of teams) header.push(team.name || '', '$');
  const rows = [header];

  const bySlot = new Map();
  for (const pick of state.picks || []) {
    bySlot.set(`${pick.teamId}::${pick.slot}`, pick);
  }

  for (const slot of slots) {
    const row = [slot.label];
    for (const team of teams) {
      const pick = bySlot.get(`${team.id}::${slot.code}`);
      row.push(pick ? pick.playerName : '', pick ? Number(pick.price) || 0 : '');
    }
    rows.push(row);
  }

  const totals = ['TOTAL'];
  for (const team of teams) {
    const s = teamSummary(state, team.id);
    totals.push('', s.spent);
  }
  rows.push(totals);

  return pad(rows, MAX_ROSTER_ROWS, Math.max(width, 1 + MAX_TEAM_COLS * 2));
}

function configRows(state) {
  const settings = state.settings || DEFAULT_SETTINGS;
  const rows = [
    ['Key', 'Value'],
    ['draftId', state.draftId || ''],
    ['draftKey', state.draftKey || ''],
    ['name', state.name || ''],
    ['revision', Number(state.revision) || 0],
    ['updatedAt', state.updatedAt || ''],
    ['status', state.status || ''],
    ['budgetPerTeam', Number(settings.budgetPerTeam) || 0],
    ['minBid', minBidOf(settings)],
    ['nominationStyle', settings.nominationStyle || 'rotating'],
    ['nominationOrder', (state.nominationOrder || []).join('|')],
    ['sleeperLeagueId', settings.sleeperLeagueId || ''],
    ['appVersion', state.appVersion || ''],
    [],
    ['Teams'],
    ['team_id', 'name', 'manager', 'sleeper_user_id'],
  ];
  for (const team of state.teams || []) {
    rows.push([team.id, team.name || '', team.manager || '', team.sleeperUserId || '']);
  }
  rows.push([]);
  rows.push(['RosterSlots']);
  rows.push(['slot_key', 'label', 'count', 'eligible_positions']);
  for (const slot of settings.rosterSlots || []) {
    rows.push([
      slot.slotKey,
      slot.label,
      Number(slot.count) || 0,
      (slot.eligiblePositions || []).join('|'),
    ]);
  }
  return pad(rows, MAX_CONFIG_ROWS, 4);
}

function backupRows(state) {
  const json = JSON.stringify(state);
  const chunks = [];
  for (let i = 0; i < json.length; i += BACKUP_CHUNK_CHARS) {
    chunks.push([chunks.length, json.slice(i, i + BACKUP_CHUNK_CHARS)]);
  }
  const rows = [['chunk', 'json'], ...chunks];
  return pad(rows, MAX_BACKUP_ROWS, 2);
}

/** The single batchUpdate payload rewriting every derived tab for one draft. */
export function stateToRanges(state) {
  const key = draftKeyOf(state);
  const rosterWidth = 1 + MAX_TEAM_COLS * 2;
  return [
    {
      range: range(key, TAB_KINDS.CONFIG, `A1:${colLetter(3)}${MAX_CONFIG_ROWS}`),
      values: configRows(state),
    },
    {
      range: range(key, TAB_KINDS.PICKS, `A1:${colLetter(PICK_HEADERS.length - 1)}${MAX_PICK_ROWS}`),
      values: picksRows(state),
    },
    {
      range: range(key, TAB_KINDS.ROSTERS, `A1:${colLetter(rosterWidth - 1)}${MAX_ROSTER_ROWS}`),
      values: rostersRows(state),
    },
    {
      range: range(key, TAB_KINDS.BUDGETS, `A1:${colLetter(BUDGET_HEADERS.length - 1)}${MAX_TEAM_ROWS}`),
      values: budgetsRows(state),
    },
    {
      range: range(key, TAB_KINDS.BACKUP, `A1:B${MAX_BACKUP_ROWS}`),
      values: backupRows(state),
    },
  ];
}

/**
 * Falls back to the draft id for state written before keys existed, so an old
 * saved draft still syncs somewhere sensible instead of failing.
 */
export function draftKeyOf(state) {
  return state.draftKey || state.draftId || 'draft';
}

/** One row describing this draft for the shared index tab. */
export function indexRow(state) {
  const spent = (state.picks || []).reduce((sum, p) => sum + (Number(p.price) || 0), 0);
  return [
    draftKeyOf(state),
    state.name || '',
    (state.createdAt || '').slice(0, 16).replace('T', ' '),
    (state.updatedAt || '').slice(0, 16).replace('T', ' '),
    (state.picks || []).length,
    spent,
    (state.teams || []).length,
    state.status || '',
    state.draftId || '',
  ];
}

export const INDEX_RANGE = `${quoteTab(INDEX_TAB)}!A1:I200`;

/** Parses the index into a list of drafts, newest activity first. */
export function parseIndex(rows) {
  return (rows || [])
    .slice(1)
    .filter((r) => r && r[0])
    .map((r) => ({
      draftKey: r[0],
      name: r[1] || '',
      created: r[2] || '',
      updated: r[3] || '',
      picks: Number(r[4]) || 0,
      spent: Number(r[5]) || 0,
      teams: Number(r[6]) || 0,
      status: r[7] || '',
      draftId: r[8] || '',
    }))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/** Rewrites the index with this draft's row inserted or updated in place. */
export function indexRowsWith(existingRows, state) {
  const key = draftKeyOf(state);
  const kept = (existingRows || [])
    .slice(1)
    .filter((r) => r && r[0] && r[0] !== key);
  const rows = [INDEX_HEADERS, ...kept, indexRow(state)];
  // Blank out any rows the list shrank past.
  const total = Math.max(rows.length, (existingRows || []).length);
  while (rows.length < total) rows.push(new Array(INDEX_HEADERS.length).fill(''));
  return rows.map((r) => {
    const row = r.slice(0, INDEX_HEADERS.length);
    while (row.length < INDEX_HEADERS.length) row.push('');
    return row;
  });
}

export function logRow(state, { client = '', summary = '' } = {}) {
  const spent = (state.picks || []).reduce((sum, p) => sum + (Number(p.price) || 0), 0);
  return [
    new Date().toISOString(),
    Number(state.revision) || 0,
    client,
    summary,
    (state.picks || []).length,
    spent,
    JSON.stringify({ draftId: state.draftId, status: state.status }),
  ];
}

export function logAppendRange(draftKey) {
  return range(draftKey, TAB_KINDS.LOG, 'A1');
}

export function configReadRange(draftKey) {
  return range(draftKey, TAB_KINDS.CONFIG, `A1:D${MAX_CONFIG_ROWS}`);
}

export function picksReadRange(draftKey) {
  return range(draftKey, TAB_KINDS.PICKS, `A1:L${MAX_PICK_ROWS}`);
}

export function backupReadRange(draftKey) {
  return range(draftKey, TAB_KINDS.BACKUP, `A1:B${MAX_BACKUP_ROWS}`);
}

/** Reads just the identity and revision used for the stale-write guard. */
export function parseConfigHead(rows) {
  const out = { draftId: '', draftKey: '', name: '', revision: 0, updatedAt: '' };
  for (const row of rows || []) {
    const key = row[0];
    if (key === 'draftId') out.draftId = row[1] || '';
    else if (key === 'draftKey') out.draftKey = row[1] || '';
    else if (key === 'name') out.name = row[1] || '';
    else if (key === 'revision') out.revision = Number(row[1]) || 0;
    else if (key === 'updatedAt') out.updatedAt = row[1] || '';
    else if (key === 'Teams') break;
  }
  return out;
}

/**
 * Rebuilds state from the sheet. Prefers the _Backup JSON (exact) and falls
 * back to reconstructing from Config/Picks if that tab is empty or corrupt.
 */
export function rowsToState({ configRows: cfg, pickRows, backupRows: backup }) {
  const fromBackup = parseBackup(backup);
  if (fromBackup) return fromBackup;
  return reconstruct(cfg, pickRows);
}

function parseBackup(rows) {
  const chunks = (rows || [])
    .slice(1)
    .filter((r) => r && r[1])
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map((r) => r[1]);
  if (!chunks.length) return null;
  try {
    const parsed = JSON.parse(chunks.join(''));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.picks) ? parsed : null;
  } catch {
    return null;
  }
}

function reconstruct(cfg, pickRows) {
  const rows = cfg || [];
  const state = {
    version: 1,
    draftId: '',
    draftKey: '',
    name: '',
    revision: 0,
    updatedAt: '',
    status: 'drafting',
    settings: { ...DEFAULT_SETTINGS, rosterSlots: [] },
    nominationOrder: [],
    teams: [],
    picks: [],
  };

  let section = 'kv';
  for (const row of rows) {
    const first = (row[0] || '').toString();
    if (first === 'Teams') {
      section = 'teams';
      continue;
    }
    if (first === 'RosterSlots') {
      section = 'slots';
      continue;
    }
    if (!first) continue;

    if (section === 'kv') {
      const value = row[1];
      if (first === 'draftId') state.draftId = value || '';
      else if (first === 'draftKey') state.draftKey = value || '';
      else if (first === 'name') state.name = value || '';
      else if (first === 'revision') state.revision = Number(value) || 0;
      else if (first === 'updatedAt') state.updatedAt = value || '';
      else if (first === 'status') state.status = value || 'drafting';
      else if (first === 'budgetPerTeam') state.settings.budgetPerTeam = Number(value) || 0;
      else if (first === 'minBid' || first === 'minReservePerOpenSlot')
        state.settings.minBid = Number(value) || 0;
      else if (first === 'nominationStyle') state.settings.nominationStyle = value || 'rotating';
      else if (first === 'nominationOrder')
        state.nominationOrder = (value || '').split('|').filter(Boolean);
      else if (first === 'sleeperLeagueId') state.settings.sleeperLeagueId = value || null;
    } else if (section === 'teams') {
      if (first === 'team_id') continue;
      state.teams.push({
        id: first,
        name: row[1] || '',
        manager: row[2] || '',
        sleeperUserId: row[3] || '',
      });
    } else if (section === 'slots') {
      if (first === 'slot_key') continue;
      state.settings.rosterSlots.push({
        slotKey: first,
        label: row[1] || first,
        count: Number(row[2]) || 0,
        eligiblePositions: (row[3] || '').split('|').filter(Boolean),
      });
    }
  }

  if (!state.settings.rosterSlots.length) state.settings.rosterSlots = DEFAULT_ROSTER_SLOTS;
  if (!state.nominationOrder.length) state.nominationOrder = state.teams.map((t) => t.id);

  const teamsByName = new Map(state.teams.map((t) => [t.name, t.id]));
  for (const row of (pickRows || []).slice(1)) {
    if (!row || !row[2]) continue;
    const overridden = (row[10] || '').toString();
    state.picks.push({
      id: `p${row[0] || state.picks.length + 1}`,
      playerName: row[2],
      position: row[3] || '',
      nflTeam: row[4] || '',
      playerId: row[5] || '',
      teamId: teamsByName.get(row[6]) || '',
      price: Number(row[8]) || 0,
      slot: row[9] || '',
      timestamp: row[1] || '',
      overrides: { budget: overridden.includes('budget'), slot: overridden.includes('slot') },
      note: row[11] || '',
    });
  }

  return state;
}
