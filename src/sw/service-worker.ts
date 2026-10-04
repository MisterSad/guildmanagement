/**
 * src/sw/service-worker.ts — SELF-DESTRUCTING TOMBSTONE. DO NOT ADD BEHAVIOUR.
 *
 * The PWA was removed entirely (Web Push decommissioned; the worker never had a
 * `fetch` handler and never touched Cache Storage, so it provided no offline
 * capability and no caching -- only installability). Nothing registers a service
 * worker any more: `src/core/pwa/pwa.ts` and its `navigator.serviceWorker
 * .register('/sw.js')` call are gone.
 *
 * But deleting this file would NOT uninstall anything. A service worker already
 * installed on a member's device keeps running forever, independently of the
 * page that registered it. The only way to retire it is to serve a *new*
 * `/sw.js` that unregisters itself: on the next in-scope navigation the browser
 * re-fetches this script, notices the bytes changed, installs it, and this
 * `activate` handler removes the registration. That update check is driven by
 * the browser, not by the page, which is why it still works with the
 * registration code deleted.
 *
 * Keep shipping this for at least one full release cycle so every returning
 * device has a chance to pick it up. Only then delete `src/sw/`, the esbuild
 * block in `scripts/build.js` and the dev plugin in `vite.config.ts`.
 *
 * The service-worker global scope lives in `lib.webworker`, which conflicts with
 * the project's DOM lib setup, so `self` is viewed through minimal structural
 * interfaces declared locally.
 */

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface WindowClientLike {
  url: string;
  navigate?: (url: string) => Promise<unknown>;
}

interface ClientsLike {
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WindowClientLike[]>;
}

interface RegistrationLike {
  unregister(): Promise<boolean>;
}

interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

interface SWGlobal {
  skipWaiting(): Promise<void>;
  clients: ClientsLike;
  registration: RegistrationLike;
  caches?: CacheStorageLike;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
}

const sw = self as unknown as SWGlobal;

sw.addEventListener('install', () => {
  // Take over immediately instead of waiting for every old tab to close --
  // the whole point of this worker is to stop existing without delay.
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Defensive: this worker never populated Cache Storage, but a future
      // regression (or a hand-edited dist/sw.js) might have. Leaving entries
      // behind would let a stale `index.html` outlive the worker.
      try {
        if (sw.caches) {
          const names = await sw.caches.keys();
          await Promise.all(names.map((name) => sw.caches!.delete(name)));
        }
      } catch {
        /* Cache Storage unavailable or blocked (private mode): nothing to purge. */
      }

      await sw.registration.unregister();

      // Reload open tabs so they stop being controlled by this worker straight
      // away rather than at their next navigation. Best-effort: `navigate()` is
      // unavailable on some browsers and rejects if the client was never
      // controlled by us.
      try {
        const clients = await sw.clients.matchAll({ type: 'window' });
        await Promise.all(
          clients.map((client) => {
            if (typeof client.navigate !== 'function') return Promise.resolve();
            return client.navigate(client.url).catch(() => undefined);
          })
        );
      } catch {
        /* Client enumeration blocked: the tabs will drop control on next load. */
      }
    })()
  );
});
