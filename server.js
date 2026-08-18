#!/usr/bin/env node
// Local run path: a static file server for public/, nothing more.
//
// The spreadsheet backup runs entirely in the browser against the operator's
// own Apps Script deployment, so there is no server-side API to host. What this
// still buys over double-clicking DraftBoard-offline.html is a stable http://
// origin, which a file:// page cannot offer -- that is what lets the service
// worker cache the app for an offline reload.
//
// Zero dependencies: `node server.js` works on a laptop with nothing installed
// but Node.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;

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
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n  Draft board running at  http://localhost:${PORT}\n`);
  console.log('  The Google Sheet backup is set up in the app, on the setup screen.\n');
  console.log('  Press Ctrl+C to stop.\n');
});
