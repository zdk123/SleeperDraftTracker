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

function isRelevant(p) {
  if (!p || !p.position || !FANTASY_POSITIONS.has(p.position)) return false;
  // Team defenses have no active flag but are always draftable.
  if (p.position === 'DEF') return Boolean(p.team);
  if (!p.team) return false; // free agents / retired
  return p.active !== false;
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

  const players = [];
  for (const [id, p] of Object.entries(all)) {
    if (!isRelevant(p)) continue;
    const name = displayName(p);
    if (!name) continue;
    players.push({
      id,
      n: name,
      p: p.position,
      t: p.team || '',
      // Precomputed lowercase search key: name + team + position, so the
      // autocomplete never lowercases anything per keystroke.
      k: `${name} ${p.team || ''} ${p.position}`.toLowerCase(),
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
  console.log(`Wrote ${players.length} players to public/data/players.json (${kb} KB).`);
  console.log('Commit this file so it deploys with the app.');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
