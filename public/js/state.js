(function (App) {
  'use strict';

  const { uid } = App.utils;

  // Single source of truth for the running draft. Every mutation bumps
  // `revision` (the sheet's stale-write guard) and notifies subscribers
  // synchronously -- the UI never waits on the network to reflect a pick.

  const DEFAULT_ROSTER_SLOTS = [
    { slotKey: 'QB', label: 'QB', count: 1, eligiblePositions: ['QB'] },
    { slotKey: 'RB', label: 'RB', count: 2, eligiblePositions: ['RB'] },
    { slotKey: 'WR', label: 'WR', count: 2, eligiblePositions: ['WR'] },
    { slotKey: 'TE', label: 'TE', count: 1, eligiblePositions: ['TE'] },
    { slotKey: 'FLEX', label: 'FLEX', count: 1, eligiblePositions: ['RB', 'WR', 'TE'] },
    { slotKey: 'DEF', label: 'DEF', count: 1, eligiblePositions: ['DEF'] },
    { slotKey: 'K', label: 'K', count: 1, eligiblePositions: ['K'] },
    {
      slotKey: 'BENCH',
      label: 'BN',
      count: 6,
      eligiblePositions: ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'],
    },
  ];

  let state = null;
  const listeners = new Set();

  function emit(reason) {
    for (const fn of listeners) {
      try {
        fn(state, reason);
      } catch (err) {
        console.error('[state] listener failed', err);
      }
    }
  }

  function touch(reason) {
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    emit(reason);
  }

  const Store = {
    DEFAULT_ROSTER_SLOTS,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    get() {
      return state;
    },

    exists() {
      return Boolean(state);
    },

    /** Installs a state object wholesale (new draft, resume, or restore). */
    load(next, reason) {
      state = next;
      emit(reason || 'load');
      return state;
    },

    create({ teams, settings, name }) {
      const roster = teams.map((t) => ({
        id: t.id || uid('team'),
        name: t.name,
        manager: t.manager || '',
        sleeperUserId: t.sleeperUserId || '',
      }));
      const draftId = uid('draft');
      state = {
        version: 1,
        appVersion: App.VERSION || '1.0.0',
        draftId,
        name: (name || '').trim(),
        // Human-readable and unique: dated, named, and tie-broken by a short
        // random suffix. Names the spreadsheet tabs and the export files, so a
        // second draft can never land on top of the first.
        draftKey: App.utils.draftKey({ name, draftId, date: new Date() }),
        revision: 1,
        status: 'drafting',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        settings: {
          budgetPerTeam: Number(settings.budgetPerTeam) || 200,
          // Sleeper's rule: the minimum bid is $1 and a team must always keep
          // at least that much per unfilled roster spot. One number drives both.
          minBid: Number(settings.minBid) || 1,
          rosterSlots: settings.rosterSlots || DEFAULT_ROSTER_SLOTS,
          nominationStyle: settings.nominationStyle || 'rotating',
          sleeperLeagueId: settings.sleeperLeagueId || null,
        },
        // Fixed for the whole draft once set; order is chosen at setup.
        nominationOrder: (settings.nominationOrder || roster.map((t) => t.id)).slice(),
        teams: roster,
        picks: [],
      };
      emit('create');
      return state;
    },

    /** Fisher-Yates: the usual way a nomination order gets decided. */
    shuffled(ids) {
      const out = ids.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },

    // --- derived values -----------------------------------------------------

    expandSlots(rosterSlots) {
      const slots = rosterSlots || state.settings.rosterSlots;
      const out = [];
      for (const slot of slots) {
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
    },

    totalSlots() {
      return state.settings.rosterSlots.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
    },

    picksFor(teamId) {
      return state.picks.filter((p) => p.teamId === teamId);
    },

    minBid() {
      const s = state.settings;
      return Number(s.minBid ?? s.minReservePerOpenSlot ?? 1) || 0;
    },

    teamSummary(teamId) {
      const budget = Number(state.settings.budgetPerTeam) || 0;
      const reserve = Store.minBid();
      const picks = Store.picksFor(teamId);
      const spent = picks.reduce((sum, p) => sum + (Number(p.price) || 0), 0);
      const remaining = budget - spent;
      const filled = picks.length;
      const open = Math.max(0, Store.totalSlots() - filled);
      // Hold back the minimum bid for every slot still to fill after this one.
      const maxBid = open === 0 ? 0 : Math.max(0, remaining - (open - 1) * reserve);
      return { budget, spent, remaining, filled, open, maxBid };
    },

    /**
     * A team may only bid while it has an open spot and can still afford the
     * minimum -- Sleeper stops a full team from bidding or nominating at all.
     */
    canBid(teamId) {
      const s = Store.teamSummary(teamId);
      return s.open > 0 && s.maxBid >= Store.minBid();
    },

    /**
     * Whose turn it is to nominate. Rotating repeats the same order every
     * round; snake reverses on odd rounds. Teams that can no longer bid are
     * skipped, matching Sleeper's "a full team cannot nominate" rule.
     */
    currentNominator() {
      const order = (state.nominationOrder || []).filter((id) => Store.teamById(id));
      if (!order.length) return null;

      const eligible = order.filter((id) => Store.canBid(id));
      if (!eligible.length) return null;

      const snake = state.settings.nominationStyle === 'snake';
      // Walk forward from the current position until an eligible team turns up,
      // so skipped teams don't stall the order.
      for (let step = 0; step < order.length * 2 + 2; step += 1) {
        const n = state.picks.length + step;
        const round = Math.floor(n / order.length);
        const indexInRound = n % order.length;
        const index =
          snake && round % 2 === 1 ? order.length - 1 - indexInRound : indexInRound;
        const teamId = order[index];
        if (Store.canBid(teamId)) return teamId;
      }
      return eligible[0];
    },

    setNominationOrder(order) {
      state.nominationOrder = order.slice();
      touch('nomination');
    },

    teamById(teamId) {
      return state.teams.find((t) => t.id === teamId) || null;
    },

    draftedPlayerIds() {
      return new Set(state.picks.filter((p) => p.playerId).map((p) => p.playerId));
    },

    /** Slot codes with nothing in them yet, for a team. */
    openSlotCodes(teamId) {
      const taken = new Set(Store.picksFor(teamId).map((p) => p.slot));
      return Store.expandSlots().filter((s) => !taken.has(s.code));
    },

    /** Open slots whose eligible positions include this one. */
    eligibleOpenSlots(teamId, position) {
      return Store.openSlotCodes(teamId).filter((s) => s.eligiblePositions.includes(position));
    },

    // --- mutations ----------------------------------------------------------

    addPick(pick) {
      const record = {
        id: uid('pick'),
        playerId: pick.playerId || '',
        playerName: pick.playerName,
        position: pick.position || '',
        nflTeam: pick.nflTeam || '',
        teamId: pick.teamId,
        price: Number(pick.price) || 0,
        slot: pick.slot || '',
        timestamp: new Date().toISOString(),
        overrides: { budget: Boolean(pick.overrides?.budget), slot: Boolean(pick.overrides?.slot) },
        note: pick.note || '',
      };
      state.picks.push(record);
      touch('pick:add');
      return record;
    },

    updatePick(pickId, changes) {
      const pick = state.picks.find((p) => p.id === pickId);
      if (!pick) return null;
      Object.assign(pick, changes, {
        price: changes.price === undefined ? pick.price : Number(changes.price) || 0,
      });
      touch('pick:update');
      return pick;
    },

    removePick(pickId) {
      const index = state.picks.findIndex((p) => p.id === pickId);
      if (index === -1) return null;
      const [removed] = state.picks.splice(index, 1);
      touch('pick:remove');
      return removed;
    },

    undoLast() {
      if (!state.picks.length) return null;
      const removed = state.picks.pop();
      touch('pick:undo');
      return removed;
    },

    updateSettings(changes) {
      Object.assign(state.settings, changes);
      touch('settings');
    },

    updateTeams(teams) {
      state.teams = teams;
      touch('teams');
    },

    setStatus(status) {
      state.status = status;
      touch('status');
    },

    /** Used after a restore-from-sheet so the next sync isn't rejected as stale. */
    bumpRevisionTo(value) {
      state.revision = Math.max(state.revision, Number(value) || 0) + 1;
      emit('revision');
    },
  };

  App.store = Store;
})(window.DraftApp);
