#!/usr/bin/env node
// Local run path. Serves public/ and dispatches /api/* to the same handler
// modules Vercel invokes, so both paths behave identically.
//
// Deliberately not `vercel dev`: that requires being logged in to Vercel and
// reachable over the network, which fails in exactly the situation this
// fallback exists for. Zero dependencies -- `node server.js` works on a laptop
// with nothing installed but Node.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './api/_lib/env.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;

loadEnvFile(join(ROOT, '.env.local'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const ROUTES = {
  '/api/health': () => import('./api/health.js'),
  '/api/sync': () => import('./api/sync.js'),
  '/api/state': () => import('./api/state.js'),
};

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
    // No caching locally: the operator should always get the file on disk.
    res.setHeader('Cache-Control', 'no-store');
    return res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  if (pathname.startsWith('/api/')) {
    const route = ROUTES[pathname];
    if (!route) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: { code: 'not_found' } }));
    }
    try {
      const mod = await route();
      return await mod.default(req, res);
    } catch (err) {
      console.error(`[api] ${pathname} failed:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: { code: 'handler_error', message: err.message } }));
      }
      return undefined;
    }
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const configured = Boolean(
    process.env.GOOGLE_SA_EMAIL &&
      process.env.GOOGLE_SA_PRIVATE_KEY_B64 &&
      process.env.SHEETS_SPREADSHEET_ID
  );
  console.log(`\n  Draft board running at  http://localhost:${PORT}\n`);
  console.log(
    configured
      ? '  Google Sheets sync: configured\n'
      : '  Google Sheets sync: OFF (no .env.local) - the draft saves locally in the browser\n'
  );
  console.log('  Press Ctrl+C to stop.\n');
});
