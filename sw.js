// Offline support: serve the app from cache, refresh it in the background.
// Bump VERSION when you deploy so phones pick up the new files.
const VERSION = 'switchback-v4';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/store.js', 'js/dates.js', 'js/rules.js', 'js/calendar.js', 'js/coach.js', 'js/progress.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
// Third-party files that never change for a given URL (pinned SDK, fonts).
const CACHE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = url.origin === location.origin;
  if (!own && !CACHE_HOSTS.includes(url.hostname)) return; // APIs always go to the network

  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: own });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
