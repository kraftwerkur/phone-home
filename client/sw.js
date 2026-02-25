// Phone Home Service Worker — caches app shell for PWA
var CACHE = 'phonehome-v1';
var SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Network-first for API and WebSocket, cache-first for app shell
  if (e.request.url.indexOf('/api/') !== -1 || e.request.url.indexOf('ws') !== -1) return;
  e.respondWith(
    fetch(e.request).catch(function() { return caches.match(e.request); })
  );
});
