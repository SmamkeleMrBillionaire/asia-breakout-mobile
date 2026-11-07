const CACHE = "ifx-r1024-v1";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { self.clients.claim(); });
self.addEventListener("fetch", e => {
  e.respondWith(
    fetch(e.request).catch(()=> caches.match(e.request))
  );
});
self.addEventListener("notificationclick", e => { e.notification.close(); e.waitUntil(clients.openWindow('/')); });
