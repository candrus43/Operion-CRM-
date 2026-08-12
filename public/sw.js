/* Operion CRM — service worker.
 *
 * Strategy (deliberately simple and safe):
 *   - Navigations:      network-first. Always try the network so the app shell,
 *                       login page and cookie-authenticated HTML stay fresh and
 *                       the user is never locked out by a stale shell. Nothing
 *                       from a navigation is ever written to the cache — so no
 *                       authenticated HTML is stored, ever. On total network
 *                       failure we fall back to the cached /offline.html.
 *   - /assets/*:        cache-first. Build assets are content-hashed and
 *                       immutable, so a cached copy is always correct.
 *   - Everything else:  left alone. Server-function RPCs (login, pipeline
 *                       mutations, OpenAI calls — GET or POST, same-origin),
 *                       HMR sockets, dev-module fetches and cross-origin
 *                       requests all pass straight through to the network and
 *                       are never cached or intercepted.
 */
const CACHE_PREFIX = "operion-crm";
const ASSET_CACHE = `${CACHE_PREFIX}-assets-v1`;
const OFFLINE_CACHE = `${CACHE_PREFIX}-offline-v1`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => {
        /* Offline fallback is best-effort; a failed pre-cache must not fail
           the install. */
      })
  );
  // Take over as soon as this version is installed — no waiting for the next
  // navigation, so a just-shipped SW (and its cache rules) applies immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== ASSET_CACHE && k !== OFFLINE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only same-origin GETs are candidates. Everything else — POST login, server
  // functions, OPTIONS preflights, cross-origin fonts/images — goes to the
  // network untouched (a service worker cannot intercept non-GET for caching
  // anyway, but be explicit: we never call respondWith for them).
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Belt-and-braces: never touch server-function / API traffic even if a
  // future runtime issues it as a GET under a special path.
  if (
    url.pathname.startsWith("/_server-fn") ||
    url.pathname.startsWith("/api/") ||
    url.searchParams.has("serverFn") ||
    req.headers.has("x-server-fn")
  ) {
    return;
  }

  // Hashed static assets — cache-first (immutable by content hash).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Navigations — network-first, offline fallback, never cached.
  if (req.mode === "navigate") {
    event.respondWith(networkFirstNav(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // Network failed and we had no cached copy — surface the network error.
    throw err;
  }
}

async function networkFirstNav(req) {
  try {
    return await fetch(req);
  } catch (err) {
    const cache = await caches.open(OFFLINE_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}
