// ISI Terminal v6.0 — Service Worker (PWA)
const CACHE = 'isi-v6-cache-v3';
const ASSETS = [
  './index.html', './style.css', './index.js', './gemini.js',
  './order-tracker.js', './session.js', './monitoring.html', './monitoring.js',
  './preentry.html', './preentry.js', './Settings.html', './settings.js',
  './algo.html', './multicluster.html', './knowledge.html', './knowledge.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Don't intercept Firebase or external requests
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
