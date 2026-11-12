const SHELL_CACHE = "zeros-shell-v1";
const ASSET_CACHE = "zeros-assets-v1";
const STATIC_ASSET = /\.(?:js|css|woff2?|svg|png|jpe?g|webp|ico)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const response = await fetch("/", { cache: "reload" });
      if (response.ok) await cache.put("/", response.clone());
    } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("zeros-") && key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
          if (url.pathname === "/" || url.pathname === "/chat") await cache.put("/", response.clone());
        }
        return response;
      } catch {
        return (await cache.match(request)) || (await cache.match("/")) || new Response(
          "<!doctype html><html lang=\"en\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Zeros offline</title><body style=\"font:16px system-ui;padding:2rem;background:#080b12;color:#f4f6fb\"><h1>Zeros is offline</h1><p>Reconnect to generate new AI results. Completed results saved on this device can still be opened from your cached chat.</p></body></html>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    })());
    return;
  }

  if (STATIC_ASSET.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })());
  }
});
