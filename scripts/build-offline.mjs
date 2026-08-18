#!/usr/bin/env node
// Bundles the whole app into one self-contained HTML file that runs by
// double-clicking it -- no Node, no server, no internet, any OS.
//
// This is the true draft-night fallback: the hosted version needs wifi and the
// local server needs Node installed, but this file needs neither. Google Sheets
// sync is the only thing it can't do (that needs a server to hold credentials),
// so it falls back to saving in the browser, which is where the draft lives
// anyway.
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

  // Inline scripts, in the order index.html already declares.
  const scriptTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)];
  let first = true;
  for (const [tag, src] of scriptTags) {
    const js = await read(src);
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
