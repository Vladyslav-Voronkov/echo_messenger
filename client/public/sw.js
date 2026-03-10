/**
 * sw.js — Echo Messenger Service Worker
 * Handles Web Push notifications and basic caching.
 */

const CACHE_NAME = 'echo-v1';

// ── Install: cache core assets ────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Push notification handler ─────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'Echo Messenger', body: 'Новое сообщение', url: '/', tag: 'echo' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {}

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body:    payload.body,
      icon:    '/favicon.svg',
      badge:   '/favicon.svg',
      tag:     payload.tag,
      data:    { url: payload.url },
      vibrate: [200, 100, 200],
      requireInteraction: false,
    })
  );
});

// ── Notification click: focus or open the app ─────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
