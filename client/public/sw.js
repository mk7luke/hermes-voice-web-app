/**
 * Service worker — app shell only.
 *
 * Scope is deliberately narrow. Caching the shell makes the app installable and
 * fast to open; caching anything else would be actively harmful here:
 *
 *  - `/api/*` responses contain session state and ephemeral tokens. A cached
 *    token is a stale credential, and a cached /api/auth/me would show a
 *    signed-out user as signed in.
 *  - There is no offline mode to speak of. A voice app without a network has
 *    nothing to say.
 *
 * So: network-first for navigation, cache-first for static assets, and API
 * requests are never touched.
 */

const CACHE = 'hermes-voice-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept anything credential-bearing or cross-origin (the xAI
  // WebSocket and API calls must always go straight to the network).
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health'
  ) {
    return;
  }

  // Navigations: try the network so a redeploy is picked up immediately, fall
  // back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Static assets are content-hashed by Vite, so cache-first is safe.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
