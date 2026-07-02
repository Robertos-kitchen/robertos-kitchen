const CACHE = 'robertos-kitchen-v1783200000';
// Pre-cache only the shell. The JS files are always requested with a
// ?v=<stamp> query, so unversioned './app.js' etc. would sit in the cache
// unused forever — the fetch handler below runtime-caches the real versioned
// URLs on first load, and those are what the offline fallback serves.
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Install: cache all assets
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
});

// Activate: delete old caches immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network first, fall back to cache
// Network first means every load checks for fresh content
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Only intercept same-origin requests (not Supabase API calls)
  const url = new URL(e.request.url);
  if (!url.origin.includes('github.io')) return;

  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(res => {
        // Got fresh response — update cache and return it
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => {
        // Network failed — serve from cache
        return caches.match(e.request);
      })
  );
});

// Listen for skip-waiting message from the app
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
