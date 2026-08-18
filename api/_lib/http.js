// Request/response helpers that behave identically under Vercel's Node runtime
// and the plain node:http server in server.js. Neither handler relies on
// Vercel's req.body/req.query conveniences.

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { ok: false, error: { code, message, ...extra } });
}

export function query(req) {
  // req.url is path-only under both hosts; the base is just to satisfy the parser.
  return new URL(req.url, 'http://localhost').searchParams;
}

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.code = 'body_too_large';
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Request body was not valid JSON');
    err.code = 'bad_json';
    throw err;
  }
}

export function methodGuard(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader('Allow', allowed.join(', '));
  sendError(res, 405, 'method_not_allowed', `Use ${allowed.join(' or ')}`);
  return false;
}
