import { timingSafeEqual } from 'node:crypto';
import { sendError } from './http.js';

// The deployed URL is public, so writes carry a shared secret the operator
// pastes into the setup screen once. Threat model is a random scanner finding
// the URL, not a targeted attacker.

export function isConfigured() {
  return Boolean(
    process.env.GOOGLE_SA_EMAIL &&
      process.env.GOOGLE_SA_PRIVATE_KEY_B64 &&
      process.env.SHEETS_SPREADSHEET_ID
  );
}

function tokenFrom(req) {
  const header = req.headers['x-draft-token'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

/** Returns true when the caller may proceed; otherwise responds and returns false. */
export function requireToken(req, res) {
  const expected = process.env.APP_WRITE_TOKEN || '';
  // No token configured means the operator opted out of the shared secret.
  if (!expected) return true;

  const supplied = tokenFrom(req);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    sendError(res, 401, 'bad_token', 'Missing or incorrect access token.');
    return false;
  }
  return true;
}
