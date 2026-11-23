// Scribe's service worker: keeps the app itself on the device, so it opens
// with no connection. It never touches /api/ (speech, the counselor, sync) and
// never fetches anything from another site. The build fills in the file list.
const FILES = __FILES__;
const CACHE = 'scribe-shell-__BUILD__';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(['./', ...FILES].map((f) => cache.add(new Request(f, { cache: 'reload' })).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (request.mode === 'navigate') {
        // The page itself: the newest copy when connected, the kept one when not.
        try {
          const fresh = await fetch(request);
          if (fresh.ok) await cache.put('./', fresh.clone());
          return fresh;
        } catch {
          return (await cache.match('./')) ?? Response.error();
        }
      }
      const kept = await cache.match(request);
      if (kept) return kept;
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(request, fresh.clone());
      return fresh;
    })(),
  );
});
