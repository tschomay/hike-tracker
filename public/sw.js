// App shell: network-first (so deploys show up), falling back to cache offline.
// Map tiles: cache-first, so anything you've looked at works without signal.
const SHELL = "shell-v1";
const TILES = "tiles-v1";
const MAX_TILES = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add("/")));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function trim() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("tile.opentopomap.org")) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(e.request.url);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === "opaque") c.put(e.request.url, res.clone()).then(trim);
        return res;
      }),
    );
  } else if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
    );
  }
});
