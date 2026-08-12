/**
 * src/core/pwa/pwa.ts
 *
 * ES Module TypeScript service managing PWA installation prompts,
 * Service Worker registration, network status monitoring, and App Badge API.
 */

import { ToastNotification } from '../../components/ui/Toast';

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        console.log('[PWA] Service Worker registered with scope:', reg.scope);
      })
      .catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  });
}

export function initNetworkStatusMonitoring(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('online', () => {
    ToastNotification.show('Connection restored. Re-syncing with server...', 'success', 3000);
  });

  window.addEventListener('offline', () => {
    ToastNotification.show('Working offline. Local changes will sync when online.', 'warning', 4000);
  });
}

export function initInstallPromptListener(onPromptAvailable?: (prompt: BeforeInstallPromptEvent) => void): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    if (onPromptAvailable) {
      onPromptAvailable(deferredPrompt);
    }
  });
}

export async function promptPWAInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;

  try {
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return choice.outcome === 'accepted';
  } catch (e) {
    console.error('[PWA] Install prompt error:', e);
    return false;
  }
}

export function setAppNotificationBadge(count: number): void {
  if (typeof navigator === 'undefined') return;

  const nav = navigator as any;
  if ('setAppBadge' in nav) {
    if (count > 0) {
      nav.setAppBadge(count).catch(() => {});
    } else {
      nav.clearAppBadge().catch(() => {});
    }
  }
}

export function initPWA(): void {
  registerServiceWorker();
  initNetworkStatusMonitoring();
  initInstallPromptListener();
}
