#!/usr/bin/env node
// Pre-draft: fetch Sleeper's full player database once, trim it to the
// fantasy-relevant players, and write public/data/players.json.
//
// Doing this ahead of time (rather than at runtime) keeps a ~10MB download off
// the venue's wifi on draft night and takes Sleeper out of the critical path
// entirely. Sleeper asks that this endpoint be called at most once a day.
//
// Usage: node scripts/build-players.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'public', 'data', 'players.json');

const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const IDP_POSITIONS = new Set(['DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S', 'ILB', 'OLB', 'SS', 'FS', 'NT']);

// A player between teams still has `team: null`, exactly like someone who
// retired in 2019 -- and Sleeper's `active`/`status` fields don't separate them
// (Tom Brady is still listed active). Recent news is what actually
// distinguishes them, so team-less players are kept only if Sleeper has
// touched their news within this window.
//
// The asymmetry matters: a retiree cluttering the autocomplete costs nothing,
// but a genuinely draftable free agent going missing means the operator has to
// free-text the name and loses the player-id link. So this errs wide.
const FREE_AGENT_NEWS_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const includeIdp = process.argv.includes('--idp');

function isRelevant(p, now) {
  if (!p || !p.position) return false;

  const fantasy = FANTASY_POSITIONS.has(p.position);
  const idp = includeIdp && IDP_POSITIONS.has(p.position);
  if (!fantasy && !idp) return false;

  // Team defenses carry no active flag but are always draftable.
  if (p.position === 'DEF') return Boolean(p.team);

  if (p.team) return p.active !== false;

  // No team: keep only if they look like a current free agent, not a retiree.
  return Boolean(p.news_updated) && now - Number(p.news_updated) < FREE_AGENT_NEWS_WINDOW_MS;
}

function displayName(p) {
  if (p.position === 'DEF') return `${p.team} Defense`;
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.full_name || '';
}

async function main() {
  process.stdout.write('Fetching player list from Sleeper (this is a large download)... ');
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`Sleeper returned HTTP ${res.status}`);
  const all = await res.json();
  process.stdout.write('done.\n');

  const now = Date.now();
  const players = [];
  let freeAgents = 0;
  for (const [id, p] of Object.entries(all)) {
    if (!isRelevant(p, now)) continue;
    const name = displayName(p);
    if (!name) continue;
    const team = p.team || '';
    if (!team) freeAgents += 1;
    players.push({
      id,
      n: name,
      p: p.position,
      t: team,
      // Precomputed lowercase search key: name + team + position, so the
      // autocomplete never lowercases anything per keystroke. "FA" is in the
      // key so a free agent is still findable by that label.
      k: `${name} ${team || 'FA'} ${p.position}`.toLowerCase(),
      ...(p.search_rank && p.search_rank < 10000 ? { r: p.search_rank } : {}),
    });
  }

  // Sleeper's search_rank approximates fantasy relevance; unranked players sort last.
  players.sort((a, b) => (a.r ?? 99999) - (b.r ?? 99999) || a.n.localeCompare(b.n));

  const payload = {
    generatedAt: new Date().toISOString(),
    count: players.length,
    players,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));

  const kb = Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024);
  console.log(
    `Wrote ${players.length} players to public/data/players.json (${kb} KB) — ` +
      `${freeAgents} without a current team.`
  );
  if (!includeIdp) {
    console.log('Individual defensive players are excluded. Re-run with --idp if your league uses them.');
  }
  console.log('Then run: node scripts/build-offline.mjs');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
