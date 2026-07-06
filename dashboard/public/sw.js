// === JARVIS MOD #25 — minimal PWA service worker (2026-07-05) ===
// Cache-first for static assets, offline shell fallback for the /jarvis route,
// and strict network-only for /api/* (SSE, TTS, auth, message send must never be
// served from cache). Registered from PwaBoot ONLY over HTTPS / in production.
// v2 (MOD #27 fix): static assets switched cache-first → network-first. This
// dashboard runs `next dev`, whose /_next/static chunk URLs are NOT content-
// hashed — cache-first pinned installed PWAs to stale JS forever (Scott's
// phone kept running pre-MOD#27 code with no working mic path). Network-first
// costs a little latency but the cache is only an offline fallback now.
const CACHE = 'jarvis-shell-v2';
const SHELL = [
  '/jarvis',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  // Precache the offline shell. addAll is atomic — if any request 404s the whole
  // install rejects, so we tolerate failure and let runtime caching backfill.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop old cache versions so a bumped CACHE name fully replaces the shell.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch API / auth / SSE or dev HMR — always go to the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/webpack-hmr')) {
    return;
  }

  // Navigations: network-first, fall back to the cached /jarvis shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/jarvis').then((r) => r || Response.error()))
    );
    return;
  }

  // Static assets: NETWORK-first, cache as offline fallback only. Cache-first
  // is unsafe here — next dev chunk URLs are not content-hashed (see v2 note).
  const isStatic =
    url.pathname.startsWith('/_next/static') ||
    SHELL.includes(url.pathname) ||
    /\.(?:png|svg|ico|webmanifest|woff2?|css|js)$/.test(url.pathname);
  if (isStatic) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Everything else: plain network (no caching).
});
// === END JARVIS MOD #25 ===
