// Offline support for the app shell. Recipe data is cached by the app itself
// (localStorage), and GitHub API requests are never intercepted here.
const CACHE = "recipe-book-v5";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "app/app.js",
  "app/format.js",
  "app/styles.css",
  "app/icons/icon-180.png",
  "app/icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so app updates show up as soon as you're online; cache when offline.
// "no-cache" makes the browser revalidate with GitHub Pages every time (a cheap 304 when
// nothing changed) instead of reusing its HTTP cache for up to 10 minutes.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match("index.html"))),
  );
});
