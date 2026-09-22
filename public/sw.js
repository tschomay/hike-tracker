// App shell: network-first (so deploys show up), falling back to cache offline.
// Map tiles: cache-first, so anything you've looked at works without signal.
const SHELL = "shell-v2";
const TILES = "tiles-v2";
const MAX_TILES = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add("/")));
  self.skipWaiting();
});
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

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
        if (res.ok) c.put(e.request.url, res.clone()).then(trim);
        return res;
      }),
    );
  } else if (url.origin === location.origin && !url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(e.request);
          if (hit) return hit;
          if (e.request.mode === "navigate") return caches.match("/");
          return Response.error();
        }),
    );
  }
});
