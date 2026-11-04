// Keeps DeerCast working in the woods with no signal.
const CACHE = "deercast-v1";
const FILES = ["./", "index.html", "app.js", "astro.js", "analysis.js", "config.js", "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // sync + weather go straight to the network
  // Cache first so the app opens instantly on one bar of signal; refresh the cache in the
  // background so updates arrive on the next open.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => cached || caches.match("index.html"));
      return cached || net;
    })
  );
});
