const CACHE = 'atlas-v1';
const PRECACHE = [
  '/',
  '/styles.css',
  '/cities-data.js',
  '/app.jsx',
  '/map.jsx',
  '/tweaks-panel.jsx',
  '/sw-register.js',
  '/manifest.json',
  '/icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API calls always go to network
  if (url.pathname.startsWith('/api/')) return;
  // Cross-origin requests (CDN scripts) pass through without SW involvement
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
