// Loads the app's classic-script modules into a fake window so Node tests can
// call them directly.
//
// The app has no build step and no ES modules -- everything hangs off
// window.DraftApp via plain <script> tags, because that is the only thing that
// works from a file:// page. Rather than keep a second, importable copy of that
// logic (which would drift), the tests evaluate the very files the browser
// loads.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string[]} files - paths under public/js, in dependency order.
 * @returns the populated window.DraftApp namespace.
 */
export function loadBrowserModules(files = ['schema.js']) {
  const win = { DraftApp: {} };
  const sandbox = {
    window: win,
    document: { addEventListener() {} },
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
      setItem(k, v) { this.store.set(k, String(v)); },
      removeItem(k) { this.store.delete(k); },
    },
    navigator: { onLine: true },
    location: { protocol: 'file:' },
    fetch: async () => { throw new Error('no network in tests'); },
  };

  for (const file of files) {
    const code = readFileSync(join(ROOT, 'public', 'js', file), 'utf8');
    const fn = new Function(
      'window', 'document', 'localStorage', 'navigator', 'location', 'console', 'fetch',
      'setTimeout', 'clearTimeout', 'setInterval',
      code
    );
    fn(
      win, sandbox.document, sandbox.localStorage, sandbox.navigator, sandbox.location,
      console, sandbox.fetch, setTimeout, clearTimeout, () => {}
    );
  }
  return win.DraftApp;
}

/** Shorthand for the common case: just the sheet mapping. */
export function loadSchema() {
  return loadBrowserModules(['schema.js']).schema;
}
