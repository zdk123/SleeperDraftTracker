// Cache-first app shell so a mid-draft wifi drop plus a page reload doesn't
// leave the operator staring at a white screen. API calls always go to the
// network -- a cached sync response would be actively harmful.

const CACHE_VERSION = 'draft-v1';

const SHELL = [
  '.',
  'index.html',
  'css/app.css',
  'css/board.css',
  'data/players.json',
  'js/utils.js',
  'js/state.js',
  'js/persistence.js',
  'js/players.js',
  'js/validation.js',
  'js/sleeperApi.js',
  'js/sync.js',
  'js/restore.js',
  'js/export.js',
  'js/views/syncStatus.js',
  'js/views/setup.js',
  'js/views/entry.js',
  'js/views/board.js',
  'js/views/history.js',
  'js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.includes('/api/') || url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Refresh in the background so the next load is current.
        fetch(event.request)
          .then((res) => {
            if (res.ok) caches.open(CACHE_VERSION).then((c) => c.put(event.request, res.clone()));
          })
          .catch(() => {});
        return cached;
      }
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
