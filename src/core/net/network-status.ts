/**
 * src/core/net/network-status.ts
 *
 * Online/offline toasts. Extracted from the deleted `src/core/pwa/pwa.ts` when
 * the PWA was removed: connectivity feedback is a plain UI concern and has
 * nothing to do with being installable.
 *
 * The wording matters. The previous copy read:
 *
 *   "Working offline. Local changes will sync when online."
 *   "Connection restored. Re-syncing with server..."
 *
 * Both were false. There is no write queue and no background sync anywhere in
 * this app -- no IndexedDB, no Cache Storage, no `sync`/`periodicsync` handler
 * (the service worker never had a `fetch` handler at all). Every write made
 * while offline is simply lost, so promising a sync actively misled users into
 * continuing to work. The copy below states what actually happens.
 */

import { ToastNotification } from '../../components/ui/Toast';

let initialised = false;

/**
 * Arms the online/offline toasts. Idempotent: calling it twice will not
 * double-bind the listeners.
 */
export function initNetworkStatusMonitoring(): void {
  if (typeof window === 'undefined' || initialised) return;
  initialised = true;

  window.addEventListener('online', () => {
    ToastNotification.show('Back online.', 'success', 3000);
  });

  window.addEventListener('offline', () => {
    ToastNotification.show(
      'You are offline. Changes will not be saved until the connection is back.',
      'warning',
      5000
    );
  });
}

export default initNetworkStatusMonitoring;
