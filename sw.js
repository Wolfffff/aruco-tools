// Offline-first: everything is served from the phone immediately, and refreshed from the
// network in the background for next time. A release bumps VERSION here and the
// `app.js?v=` number in index.html together, so a page and its scripts never mix releases.
const VERSION = 13;
const CACHE = 'aruco-tools-v' + VERSION;
const CORE = [
  './',
  'index.html',
  `app.js?v=${VERSION}`,
  `worker.js?v=${VERSION}`,
  'vendor/cv.js',
  'vendor/aruco.js',
  'vendor/dictionaries/aruco_4x4_1000.js',
  'generate.html',
  'icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const refresh = fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  });
  e.respondWith(caches.match(e.request).then((hit) => {
    if (hit) {
      e.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  }));
});
