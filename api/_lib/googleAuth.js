import { createSign } from 'node:crypto';

// Hand-rolled service-account auth: sign an RS256 JWT and trade it for an
// access token. This is all the `googleapis` package would do for us here, and
// avoiding the dependency keeps `npm install` out of the picture entirely --
// which is what lets the local fallback server run on a laptop with nothing
// but Node installed.

// SIM_GOOGLE_BASE exists only so the simulation harness can point this at a
// stub. Never set it in a real deployment.
const TOKEN_URL = process.env.SIM_GOOGLE_BASE
  ? `${process.env.SIM_GOOGLE_BASE}/token`
  : 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const LIFETIME_SECONDS = 3600;
const REFRESH_MARGIN_SECONDS = 300;

let cached = null; // { token, expiresAt }

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function privateKey() {
  const b64 = process.env.GOOGLE_SA_PRIVATE_KEY_B64;
  if (!b64) throw credentialError('GOOGLE_SA_PRIVATE_KEY_B64 is not set.');
  let pem = Buffer.from(b64.trim(), 'base64').toString('utf8');
  // Tolerate a key that was pasted raw with escaped newlines rather than base64-encoded.
  if (!pem.includes('BEGIN')) pem = b64.replace(/\\n/g, '\n');
  if (!pem.includes('BEGIN')) {
    throw credentialError(
      'GOOGLE_SA_PRIVATE_KEY_B64 did not decode to a PEM private key. Re-encode the ' +
        'private_key value from the service account JSON with base64.'
    );
  }
  return pem;
}

function credentialError(message) {
  const err = new Error(message);
  err.code = 'bad_credentials';
  return err;
}

/** Returns a cached-until-nearly-expired Google access token. */
export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - REFRESH_MARGIN_SECONDS > now) return cached.token;

  const email = process.env.GOOGLE_SA_EMAIL;
  if (!email) throw credentialError('GOOGLE_SA_EMAIL is not set.');

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + LIFETIME_SECONDS,
    })
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  let signature;
  try {
    signature = signer.sign(privateKey(), 'base64');
  } catch (cause) {
    throw credentialError(`Could not sign with the service account key: ${cause.message}`);
  }
  const jwt = `${header}.${claims}.${signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw credentialError(`Google rejected the service account credentials: ${detail}`);
  }

  cached = { token: data.access_token, expiresAt: now + (data.expires_in || LIFETIME_SECONDS) };
  return cached.token;
}

/** Test hook: drops the in-memory token so the next call re-authenticates. */
export function resetTokenCache() {
  cached = null;
}
