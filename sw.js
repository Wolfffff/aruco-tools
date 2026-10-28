// Offline-first: the app is served from the phone immediately. A release bumps VERSION
// here together with the ?v= numbers in the pages, and installing the new version
// downloads every file below in one go, so a page and its scripts never mix releases.
const VERSION = 25;
const CACHE = 'aruco-tools-v' + VERSION;
const DICTIONARIES = [
  'aruco_4x4_1000', 'aruco_5x5_1000', 'aruco_6x6_1000', 'aruco_7x7_1000', 'aruco_default_opencv',
  'aruco_mip_36h12', 'apriltag_16h5', 'apriltag_25h9', 'apriltag_36h11',
].map((d) => `vendor/dictionaries/${d}.js`);
const FILES = [
  './',
  'index.html',
  'generate.html',
  'bench.html',
  `app.js?v=${VERSION}`,
  `worker.js?v=${VERSION}`,
  `markers.js?v=${VERSION}`,
  `ui.css?v=${VERSION}`,
  'vendor/cv.js',
  'vendor/aruco.js',
  ...DICTIONARIES,
  'fonts/geist-latin.woff2',
  'icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) => {
    if (hit) {
      // Keep static files fresh in the background. Pages are left to the next release,
      // so a page can never point at scripts this cache does not have.
      if (req.mode !== 'navigate') e.waitUntil(refresh(req).catch(() => {}));
      return hit;
    }
    return refresh(req);
  }));
});

// Fetches from the network and, for files the app ships, updates the cache.
function refresh(req) {
  return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    const url = new URL(req.url);
    const known = FILES.some((f) => new URL(f, self.registration.scope).href === url.href);
    if (!res.ok || !known) return res;
    const copy = res.clone();
    return caches.open(CACHE).then((c) => c.put(req, copy)).then(() => res);
  });
}
