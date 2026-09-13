/**
 * src/sw/service-worker.ts
 *
 * TypeScript port of the legacy root `sw.js`. Web Push event reminders only:
 * install / activate / push / notificationclick.
 *
 * Deliberate invariant: this worker has NO `fetch` handler and NEVER touches
 * the Cache Storage API. The app owns its own `?v=` asset versioning and must
 * never be served stale.
 *
 * Compiled to `dist/sw.js` (root scope) by `scripts/build.js` via esbuild, and
 * served on the fly in dev by the Vite plugin in `vite.config.ts`.
 *
 * The service-worker global scope lives in `lib.webworker`, which conflicts
 * with the project's DOM lib setup, so `self` and the APIs it exposes are
 * viewed through minimal structural interfaces declared locally.
 */

import { parsePushPayload, type PushMessageDataLike } from './push-payload';

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface PushEventLike extends ExtendableEventLike {
  data: PushMessageDataLike | null;
}

interface NotificationLike {
  close(): void;
  data?: { url?: string } | null;
}

interface NotificationEventLike extends ExtendableEventLike {
  notification: NotificationLike;
}

interface ClientLike {
  focus?: () => Promise<unknown>;
}

interface ClientsLike {
  claim(): Promise<void>;
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<ClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

interface RegistrationLike {
  showNotification(title: string, options: NotificationOptionsLike): Promise<void>;
}

interface NotificationOptionsLike {
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  renotify?: boolean;
  data?: unknown;
}

interface SWGlobal {
  skipWaiting(): Promise<void>;
  clients: ClientsLike;
  registration: RegistrationLike;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEventLike) => void
  ): void;
  addEventListener(type: 'push', listener: (event: PushEventLike) => void): void;
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationEventLike) => void
  ): void;
}

const sw = self as unknown as SWGlobal;

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
  const payload = parsePushPayload(event.data);
  const options: NotificationOptionsLike = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag,
    renotify: true,
    data: { url: payload.url },
  };
  event.waitUntil(sw.registration.showNotification(payload.title, options));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.focus) return client.focus();
      }
      return sw.clients.openWindow(target);
    })
  );
});