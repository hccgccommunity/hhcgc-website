// Network-first service worker for the HCCGC Admin Portal.
//
// Deliberately does NOT precache a hardcoded list of files. That pattern
// (common in PWA tutorials) means every new app, renamed file, or moved
// page needs this file updated too — a third sync point on top of the
// admin-portal and user-management registries that already exist.
// Runtime caching avoids that entirely: whatever gets requested gets
// cached as it's requested, nothing to list up front.
//
// Also deliberately network-first, not cache-first: always tries the
// live server first, only falls back to the cache if the network fails
// (offline, or the request times out). This means a normal deploy just
// works immediately for every app — no version bump, no cache-busting
// step, no risk of someone seeing stale content the way the admin-portal
// tile list did earlier when a browser cache was suspected.

const CACHE_NAME = 'hccgc-admin-runtime-v2';
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  // Only handle GET requests for same-origin pages/assets — never intercept
  // API calls to the Cloud Run backend or anything cross-origin, since those
  // should always go straight to the network with no caching involved.
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    Promise.race([
      fetch(event.request).then(function (response) {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('network timeout')); }, NETWORK_TIMEOUT_MS);
      })
    ]).catch(function () {
      return caches.match(event.request).then(function (cached) {
        return cached || Promise.reject(new Error('offline and not cached'));
      });
    })
  );
});
