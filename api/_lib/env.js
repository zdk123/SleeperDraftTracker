// Reads credentials from a `.env.local` file for local runs.
//
// Vercel injects environment variables directly, so this only matters when the
// operator runs `node server.js` on their own laptop. Real environment
// variables always win: anything already set in the shell is left alone, which
// is what makes `GOOGLE_SA_EMAIL=... node server.js` work without a file at all.
//
// Hand-rolled rather than pulling in dotenv, to keep `npm install` out of the
// picture entirely -- the local fallback has to work on a laptop with nothing
// installed but Node.

import { existsSync, readFileSync } from 'node:fs';

/**
 * Parse .env-style text into a plain object.
 * Tolerates Windows line endings, `export ` prefixes pasted from shell
 * instructions, and quoted values. Values may contain `=` (base64 padding).
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load `path` into process.env without overwriting anything already set. */
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return [];
  const applied = [];
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (key in env) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
