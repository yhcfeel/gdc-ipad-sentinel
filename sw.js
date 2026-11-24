const CACHE_PREFIX = 'gdc-ipad-sentinel-';
const CACHE_NAME = CACHE_PREFIX + 'v5';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=5',
  './app.js?v=5',
  './manifest.json',
  './vendor/mqtt.min.js',
  './assets/alert.wav',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(
        PRECACHE_ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const oldCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(oldCaches.map((key) => caches.delete(key)));
    await self.clients.claim();

    if (oldCaches.length > 0) {
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) {
          // Let activation finish before the new worker handles the navigation.
          client.navigate(client.url).catch(() => {});
        }
      }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only intercept requests under this app's deployment path.
  if (!url.href.startsWith(self.registration.scope)) return;

  // Vendor library, audio assets & icons: Cache-First
  if (
    url.pathname.includes('/vendor/') ||
    url.pathname.includes('/icons/') ||
    url.pathname.includes('/assets/')
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        });
      })
    );
    return;
  }

  // App shell (HTML / CSS / JS / Manifest): Stale-While-Revalidate for instant offline boot
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(networkFetch);
        return cached;
      }

      return networkFetch.then((resp) => {
        if (resp) return resp;
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
