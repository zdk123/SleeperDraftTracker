#!/usr/bin/env node
// Bundles the whole app into one self-contained HTML file that runs by
// double-clicking it -- no Node, no server, no internet, any OS.
//
// This is the true draft-night fallback: the hosted version needs wifi and the
// local server needs Node installed, but this file needs neither. It backs up
// to a Google Sheet just like the hosted app does -- the browser posts rows
// straight to the operator's own Apps Script deployment, so no server is needed
// to hold a credential.
//
// Usage: node scripts/build-offline.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(ROOT, 'DraftBoard-offline.html');

const read = (rel) => readFile(join(PUBLIC, rel), 'utf8');

/** Keeps `</script>` inside inlined data from ending the surrounding tag. */
function safeJson(text) {
  return text.replace(/</g, '\\u003c');
}

/**
 * Always replace via a function. A string replacement would interpret `$$`,
 * `$&`, "$`" and `$'` inside the file being inlined -- `$'` in particular
 * splices in the rest of the document, and utils.js legitimately contains
 * `$${...}` in a template literal, which would silently lose its dollar sign.
 */
function inline(haystack, needle, replacement) {
  return haystack.replace(needle, () => replacement);
}

async function main() {
  let html = await read('index.html');
  const players = await read('data/players.json');

  // Inline stylesheets.
  const styleLinks = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/g)];
  for (const [tag, href] of styleLinks) {
    const css = await read(href);
    html = inline(html, tag, `<style>\n${css}\n</style>`);
  }

  // Assets with no possible use from a file:// page. The QR encoder is 57KB
  // that could never run here: a share link needs a web address other people
  // can open, and this build has none -- shareLink.availability() refuses on
  // protocol alone. A stub keeps shareCode.js from throwing on a missing global
  // while costing nothing.
  const UNUSED_OFFLINE = {
    'js/vendor/qrcode.js':
      '// QR encoding is omitted from the offline build: a file:// page has no\n' +
      '// address to put in a link, so sharing is refused before this would run.\n' +
      'window.qrcode = function () {\n' +
      '  throw new Error("QR codes need the hosted version of the draft board.");\n' +
      '};',
  };

  // Inline scripts, in the order index.html already declares.
  const scriptTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)];
  let first = true;
  for (const [tag, src] of scriptTags) {
    const js = UNUSED_OFFLINE[src] ?? (await read(src));
    // The player list has to be in place before players.js runs.
    const preamble = first ? `window.__PLAYERS__ = ${safeJson(players)};\n` : '';
    first = false;
    html = inline(html, tag, `<script>\n${preamble}${js}\n</script>`);
  }

  html = inline(
    html,
    '<title>Auction Draft Board</title>',
    '<title>Auction Draft Board (offline)</title>'
  );

  // Leftover references would 404 from a file:// page.
  if (/<link[^>]+href="css\//.test(html) || /<script src="js\//.test(html)) {
    throw new Error('Some assets were not inlined — check index.html tag formatting.');
  }

  await writeFile(OUT, html);
  const kb = Math.round(Buffer.byteLength(html) / 1024);
  console.log(`Wrote DraftBoard-offline.html (${kb} KB, ${scriptTags.length} scripts inlined).`);
  console.log('Double-click it in any browser — no Node, no server, no internet needed.');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
