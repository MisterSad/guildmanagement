/**
 * sw.js — Service worker for Web Push event reminders.
 * Push + notificationclick only. No fetch/caching: the app keeps its
 * own ?v= asset versioning and must not be served stale.
 */
self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
    var data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: 'Guild Management Tool', body: event.data ? event.data.text() : '' };
    }
    var title = data.title || 'Guild Management Tool';
    var options = {
        body:     data.body || '',
        icon:     '/icon-192.png',
        badge:    '/icon-192.png',
        tag:      data.tag || 'gmt-event',
        renotify: true,
        data:     { url: (data.url && data.url !== '/') ? data.url : '/app/' }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var target = (event.notification.data && event.notification.data.url) || '/app/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (var i = 0; i < clientList.length; i++) {
                if ('focus' in clientList[i]) return clientList[i].focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(target);
        })
    );
});
