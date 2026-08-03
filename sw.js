// Incrémenter ce numéro à chaque changement du code de l'app force une
// invalidation propre de l'ancien cache (voir activate ci-dessous).
const CACHE_NAME = "suivi-shell-v41";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-192.png",
  "./icon-maskable-512.png",
  "./icon-trash.png",
  "./icon-trash-blue.png",
  "./icon-series.png",
  "./icon-animes.png",
  "./icon-films.png",
  "./icon-mangas.png",
  "./logo-omnivore.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // On ne gère que les fichiers de l'app (même origine). Les appels vers
  // l'API GitHub / TVmaze / AniList doivent toujours aller chercher des
  // données fraîches sur le réseau, jamais depuis le cache.
  if (url.origin !== self.location.origin) return;

  // Réseau d'abord : sert toujours la dernière version du code dès qu'il y a
  // du réseau, et met à jour le cache au passage. Le cache ne sert que de
  // secours si le téléphone est hors-ligne. Ça évite de rester bloqué sur une
  // vieille version de l'app après une mise à jour (ce qui vient de nous arriver).
  // `cache: "no-store"` est nécessaire ici : sans ça, un simple fetch() reste
  // soumis au cache HTTP habituel du navigateur (GitHub Pages renvoie des
  // en-têtes Cache-Control avec une durée de vie non nulle), qui peut alors
  // renvoyer une réponse silencieusement périmée sans repasser par le réseau
  // — exactement ce qu'on cherche à éviter avec cette stratégie.
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
