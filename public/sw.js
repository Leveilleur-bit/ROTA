// Service worker ROTA — cache à l'exécution pour un fonctionnement hors-ligne.
// Après une première visite en ligne, l'app se recharge sans réseau.
const CACHE = "rota-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // on ignore le cross-origin (polices, etc.)

  // Navigation : on récupère TOUJOURS un index.html frais (jamais le cache HTTP),
  // pour ne pas pointer vers d'anciens fichiers supprimés après un redéploiement.
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: "no-store" });
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (err) {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(req)) ||
            (await cache.match(self.registration.scope)) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Autres ressources (JS/CSS à nom haché = immuables) : cache d'abord, sinon réseau.
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return cached || Response.error();
      }
    })()
  );
});
