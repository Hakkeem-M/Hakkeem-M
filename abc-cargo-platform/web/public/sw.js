// ABC Cargo PWA service worker: app-shell caching for Driver / Warehouse / Customer apps.
// API calls are never cached (always live data; offline scans are queued by the app itself).
const CACHE = 'abc-cargo-v1';
const SHELL = ['/driver', '/warehouse', '/customer'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => null)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Immutable hashed assets: cache-first.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  if (e.request.mode === 'navigate') {
    // HTML: network-first, fall back to cached shell when offline.
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match(url.pathname.replace(/\/$/, '')))));
  }
});
