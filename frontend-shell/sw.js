const CACHE_NAME = 'evoleaf-shell-v1';
const APP_SHELL = [
  '/app/',
  '/app/styles.css',
  '/app/app.js',
  '/manifest.webmanifest',
  '/app/icons/app-icon.svg',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith('/app/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) {
          return cached;
        }

        return fetch(request).then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        });
      })
    );
  }
});
