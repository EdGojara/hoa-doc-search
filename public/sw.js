// ============================================================================
// askEd Service Worker — v1
// ----------------------------------------------------------------------------
// Minimal service worker that makes the app installable as a PWA and gives
// us a tiny offline shell. We intentionally do NOT cache API responses —
// askEd answers must always be fresh (community docs + playbook may have
// changed between sessions).
//
// Strategy:
//   - Cache the app shell (HTML, manifest, logo) on install
//   - Network-first for everything else; fall back to cache if the network
//     is unreachable. For /api/* and /ask-ed, never serve from cache.
//   - Bump CACHE_VERSION when shipping a new shell.
// ============================================================================

const CACHE_VERSION = 'asked-v2.6-2026-05-12';
const SHELL = [
  '/voice.html',
  '/manifest.json',
  '/logos/bedrock_logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — answers must be fresh
  if (url.pathname.startsWith('/api/') || url.pathname === '/ask-ed') {
    return; // let the browser handle it normally
  }

  // Network-first for everything else, falling back to the cached shell
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        // Opportunistically cache successful GETs of same-origin static assets
        if (
          event.request.method === 'GET' &&
          url.origin === self.location.origin &&
          resp.ok &&
          !url.pathname.startsWith('/ask-ed') &&
          !url.pathname.startsWith('/api/')
        ) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(event.request).then((m) => m || caches.match('/voice.html')))
  );
});
