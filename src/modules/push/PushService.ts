/**
 * src/modules/push/PushService.ts
 *
 * Strangler Phase 1 port of the root `push.js` Web Push opt-in. Registers the
 * service worker, renders an opt-in control whose label reflects the current
 * state, and stores the subscription server-side via the
 * `save_push_subscription` RPC.
 *
 * iOS note: PushManager only exists inside an installed PWA (iOS 16.4+). In a
 * plain Safari tab an "add to home screen" hint is surfaced instead.
 *
 * This module never assigns `window.GM_PUSH` (parity bridge is added at cutover
 * in src/main.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function navAny(): any {
  return (typeof navigator !== 'undefined' ? navigator : ({} as any)) as any;
}

const legacy = {
  t(key: string): string {
    const g = winAny().GM;
    return g && typeof g.t === 'function' ? g.t(key) : key;
  },
  esc(value: unknown): string {
    const g = winAny().GM;
    if (g && typeof g.escapeHTML === 'function') return g.escapeHTML(value);
    return value === null || value === undefined ? '' : String(value);
  },
  showToast(msg: string, type: string): void {
    const g = winAny().GM;
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  db(): any {
    const g = winAny().GM;
    return g && g.db ? g.db : null;
  },
  currentPseudo(): string | null {
    const g = winAny().GM;
    return g && typeof g.getCurrentPseudo === 'function' ? g.getCurrentPseudo() : null;
  }
};

export class PushService {
  /** Decommissioned: Mobile PWA push notifications have been removed. */
  public init(): void {}

  public async render(container: Element | null): Promise<void> {
    if (container) container.innerHTML = '';
  }

  public mount(_container: Element | null): void {}
}

/** Shared singleton instance (bridged to `window.GM_PUSH` at cutover). */
export const pushService = new PushService();

export default pushService;
