// ISI Terminal v6.0 — Service Worker (PWA)
const CACHE = 'isi-v6-cache-v21';
const ASSETS = [
  './index.html', './daybook.js', './terminal.html', './terminal.js',
  './style.css', './gemini.js',
  './order-tracker.js', './session.js', './monitoring.html', './monitoring.js',
  './preentry.html', './preentry.js', './Settings.html', './settings.js',
  './algo.html', './multicluster.html', './knowledge.html', './knowledge.js',
  './cost-report.js', './page-maximize.js', './orientation-control.js', './news-popup.js',
  './advanced-metrics.js', './news-impact.js', './all-trades-report.js', './smi-terminal-report.js',
  './chart-overview-report.js', './pnl-circles-report.js',
  './trade-report.html', './trade-report.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/logo-icon.png'
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

  const url = e.request.url;
  const isCode = url.endsWith('.js') || url.endsWith('.html') || url.endsWith('.css');

  if (isCode) {
    // NETWORK-FIRST for code files — always get latest, fallback to cache if offline
    e.respondWith(
      fetch(e.request).then(res => {
        // Clone SYNCHRONOUSLY, in the same tick — cloning inside the async
        // caches.open().then() callback below race-conditions against the
        // browser already starting to read/stream 'res' body once it's
        // returned, throwing "Response body is already used".
        const resClone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, resClone));
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // CACHE-FIRST for static assets (icons, manifest)
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
