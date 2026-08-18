(function (App) {
  'use strict';

  const { store } = App;

  // All guardrails are local and synchronous -- they read in-memory state only
  // and never wait on the network. The server deliberately performs no
  // validation: a rejection arriving mid-draft would be unactionable for the
  // operator and a source of divergence between sheet and screen.
  //
  // Blockers stop the pick; a blocker with `overridable: true` can be waved
  // through with an explicit confirmation.
  //
  // What is NOT overridable are the rules Sleeper itself enforces, because a
  // draft that breaks them cannot be entered into Sleeper afterward -- which is
  // the whole point of tracking it here:
  //   - a player can only be drafted once
  //   - the minimum bid is $1
  //   - a team must keep at least the minimum bid per unfilled roster spot
  //   - a team whose roster is full cannot bid at all
  // Slot classification stays overridable: which spot a player fills is a
  // judgment call (FLEX especially), not a money rule.

  /**
   * A team's budget/slot position with one pick discounted, so an edit is
   * judged against what the team would look like without the pick being
   * changed rather than with it counted twice.
   */
  function summaryExcluding(teamId, ignorePickId) {
    const summary = store.teamSummary(teamId);
    if (!ignorePickId) return summary;

    const pick = store.get().picks.find((p) => p.id === ignorePickId);
    if (!pick || pick.teamId !== teamId) return summary;

    const spent = summary.spent - (Number(pick.price) || 0);
    const filled = summary.filled - 1;
    const open = store.totalSlots() - filled;
    const reserve = store.minBid();
    return {
      ...summary,
      spent,
      filled,
      open,
      remaining: summary.budget - spent,
      maxBid: open <= 0 ? 0 : Math.max(0, summary.budget - spent - (open - 1) * reserve),
    };
  }

  App.validation = {
    /**
     * @returns {{blockers: Array, warnings: Array, slotOptions: Array, canOverride: boolean}}
     */
    /**
     * @param ignorePickId - when re-checking an existing pick (an edit), the
     *   pick being changed must not count against itself: it would flag its own
     *   player as a duplicate and its own price against the team's budget.
     */
    check({ teamId, playerId, playerName, position, price, slot, ignorePickId }) {
      const blockers = [];
      const warnings = [];
      const state = store.get();
      const others = ignorePickId
        ? state.picks.filter((p) => p.id !== ignorePickId)
        : state.picks;

      if (!teamId) blockers.push({ code: 'no_team', message: 'Pick a team.', overridable: false });
      if (!playerName) {
        blockers.push({ code: 'no_player', message: 'Pick a player.', overridable: false });
      }

      const minBid = store.minBid();
      const amount = Number(price);
      if (!Number.isFinite(amount)) {
        blockers.push({ code: 'bad_price', message: 'Enter a price.', overridable: false });
      } else if (amount < minBid) {
        blockers.push({
          code: 'below_min',
          message: `The minimum bid is ${App.utils.money(minBid)}.`,
          overridable: false,
        });
      }

      // Duplicate player: hard block, never overridable.
      if (playerId) {
        const existing = others.find((p) => p.playerId === playerId);
        if (existing) {
          const owner = store.teamById(existing.teamId);
          blockers.push({
            code: 'duplicate',
            message: `${playerName} already went to ${owner ? owner.name : 'another team'} for ${App.utils.money(existing.price)}.`,
            overridable: false,
          });
        }
      } else if (playerName) {
        const existing = others.find(
          (p) => p.playerName.toLowerCase() === playerName.toLowerCase()
        );
        if (existing) {
          const owner = store.teamById(existing.teamId);
          blockers.push({
            code: 'duplicate',
            message: `${playerName} already went to ${owner ? owner.name : 'another team'}.`,
            overridable: false,
          });
        }
      }

      let slotOptions = [];
      if (teamId) {
        const summary = summaryExcluding(teamId, ignorePickId);
        const team = store.teamById(teamId);

        if (summary.open === 0) {
          // Sleeper: a team with a full draftboard column cannot bid at all.
          blockers.push({
            code: 'roster_full',
            message: `${team.name}'s roster is full — they can't bid.`,
            overridable: false,
          });
        } else if (Number.isFinite(amount) && amount > summary.maxBid) {
          const held = summary.open - 1;
          blockers.push({
            code: 'over_budget',
            message:
              `${team.name} can bid at most ${App.utils.money(summary.maxBid)} — ` +
              `${App.utils.money(summary.remaining)} left, holding ${App.utils.money(minBid)} each ` +
              `for ${held} more spot${held === 1 ? '' : 's'}.`,
            overridable: false,
          });
        }

        if (position) {
          slotOptions = store.eligibleOpenSlots(teamId, position, ignorePickId);
          if (!slotOptions.length && summary.open > 0) {
            blockers.push({
              code: 'slot_full',
              message: `${team.name} has no open ${position} slot.`,
              overridable: true,
            });
            // Offer any open slot when overriding -- FLEX eligibility is fuzzy.
            slotOptions = store.openSlotCodes(teamId, ignorePickId);
          }
        }

        if (slot && !slotOptions.some((s) => s.code === slot) && slotOptions.length) {
          warnings.push({ code: 'slot_mismatch', message: `Slot ${slot} is not open.` });
        }

        if (Number.isFinite(amount) && amount > 0 && amount === summary.remaining && summary.open > 1) {
          warnings.push({
            code: 'spends_all',
            message: `This spends everything ${team.name} has left with ${summary.open - 1} slots still open.`,
          });
        }
      }

      return {
        blockers,
        warnings,
        slotOptions,
        canOverride: blockers.length > 0 && blockers.every((b) => b.overridable),
        ok: blockers.length === 0,
      };
    },

    /** Which override flags a set of blockers implies, for the pick record. */
    overrideFlags(blockers) {
      return {
        budget: false, // money rules are never waived
        slot: blockers.some((b) => b.code === 'slot_full'),
      };
    },

    /** Teams allowed to win this bid, for the "won by" dropdown. */
    eligibleTeams(price) {
      const amount = Number(price);
      return store.get().teams.map((team) => {
        const summary = store.teamSummary(team.id);
        const affordable = !Number.isFinite(amount) || amount <= summary.maxBid;
        return {
          ...team,
          summary,
          eligible: summary.open > 0 && affordable,
          reason: summary.open === 0 ? 'roster full' : affordable ? '' : `max ${App.utils.money(summary.maxBid)}`,
        };
      });
    },
  };
})(window.DraftApp);
