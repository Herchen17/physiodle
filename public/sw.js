// Physiodle service worker.
// Deliberately minimal: no fetch handler and no caching, so a stale cache can
// never serve an old puzzle or an old build. It exists so the site meets the
// install criteria on Android/Chrome and so Web Push can be added later.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
