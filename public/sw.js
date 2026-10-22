'use strict';
// Match Arena service worker, versioned cache.
// Caches static assets only. Authenticated API responses, tokens and
// user data are never cached: any request whose path is not a known
// static asset goes to the network, and navigation falls back to the
// offline page when the network is unavailable.
const CACHE_NAME = 'match-arena-v1';
const STATIC_ASSETS = [
  '/', '/index.html', '/styles.css', '/manifest.json', '/offline.html',
  '/icons/icon-192.svg', '/icons/icon-512.svg',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
    return;
  }
  if (STATIC_ASSETS.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return res;
    })));
  }
  // All other same-origin requests (API, uploads, avatars, banners)
  // are network-only and are never written to this cache.
});
