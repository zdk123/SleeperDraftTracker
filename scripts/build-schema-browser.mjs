#!/usr/bin/env node
// Generates public/js/schema.js from api/_lib/schema.js.
//
// Why this exists: the Apps Script backend has no server in the middle -- the
// browser posts finished spreadsheet rows straight to Google. That means the
// browser needs the same state->rows mapping the server uses. Hand-copying 500
// lines of mapping into a second file is how the sheet quietly starts
// disagreeing with itself months later, so instead the browser copy is
// generated: same source, `export` stripped, wrapped in the classic-script
// IIFE the page expects.
//
// The generated file is committed (the app has no build step at runtime), and
// scripts/test.mjs regenerates it and fails if the committed copy differs -- so
// editing schema.js without re-running this is caught immediately.
//
// Run with: node scripts/build-schema-browser.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'api', '_lib', 'schema.js');
const TARGET = join(ROOT, 'public', 'js', 'schema.js');

export function generate(source) {
  const names = [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  if (!names.length) throw new Error('found no exports in schema.js -- did its style change?');

  const stray = source.match(/^export (?!const |function )/m);
  if (stray) throw new Error(`unsupported export form: ${stray[0].trim()}`);

  const body = source.replace(/^export /gm, '');
  const exposed = names.map((n) => `    ${n},`).join('\n');

  return [
    '// GENERATED FILE -- do not edit.',
    '// Built from api/_lib/schema.js by scripts/build-schema-browser.mjs.',
    '// Edit the source and re-run that script; scripts/test.mjs enforces it.',
    '',
    '(function (App) {',
    "  'use strict';",
    '',
    body.trimEnd(),
    '',
    '  App.schema = {',
    exposed,
    '  };',
    '})(window.DraftApp);',
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = generate(readFileSync(SOURCE, 'utf8'));
  writeFileSync(TARGET, out);
  console.log(`Wrote public/js/schema.js (${Math.round(out.length / 1024)} KB) from api/_lib/schema.js.`);
}

export { SOURCE, TARGET };
