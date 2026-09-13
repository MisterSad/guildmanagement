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

const VAPID_PUBLIC = 'BKJ-mf-as7Si__DvBVRPN8EdpqnjihviHfkHZSvB_HgK5V68dG85WT8oDLvkE9_AQQw7gQqs7jeOn_a2ofrpBvo';

export class PushService {
  private swReg: any = null;
  private isEnabling = false;
  private mounted: Element[] = [];

  /** Eager service-worker registration on window load (legacy behaviour). */
  public init(): void {
    const w = winAny();
    if (w.navigator && 'serviceWorker' in w.navigator) {
      w.addEventListener('load', () => {
        w.navigator.serviceWorker.register('/sw.js').then((reg: any) => {
          this.swReg = reg;
        }).catch((e: any) => { console.error('sw register', e); });
      });
    }
  }

  private supported(): boolean {
    const w = winAny();
    return ('serviceWorker' in navAny()) && ('PushManager' in w) && ('Notification' in w);
  }

  private isIOS(): boolean {
    return /iphone|ipad|ipod/i.test(String(navAny().userAgent || ''));
  }

  private isStandalone(): boolean {
    const w = winAny();
    return (typeof w.matchMedia === 'function' && w.matchMedia('(display-mode: standalone)').matches) ||
      navAny().standalone === true;
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  private byteArraysEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
    const ua = new Uint8Array(a as any);
    const ub = new Uint8Array(b as any);
    if (ua.byteLength !== ub.byteLength) return false;
    for (let i = 0; i < ua.length; i++) {
      if (ua[i] !== ub[i]) return false;
    }
    return true;
  }

  private async getReg(): Promise<any> {
    if (this.swReg) return this.swReg;
    if ('serviceWorker' in navAny()) {
      this.swReg = await navAny().serviceWorker.register('/sw.js');
      return this.swReg;
    }
    return null;
  }

  private async currentSubscription(): Promise<any> {
    try {
      const reg = await this.getReg();
      if (!reg) return null;
      const sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && sub.options.applicationServerKey) {
        const expected = this.urlBase64ToUint8Array(VAPID_PUBLIC);
        if (!this.byteArraysEqual(sub.options.applicationServerKey, expected)) {
          // Public key mismatch: unsubscribe to force resubscription with the new key.
          await sub.unsubscribe();
          return null;
        }
      }
      return sub;
    } catch (_) {
      return null;
    }
  }

  private async enable(): Promise<void> {
    if (this.isEnabling) return;
    this.isEnabling = true;
    const w = winAny();
    try {
      const perm = await w.Notification.requestPermission();
      if (perm !== 'granted') {
        legacy.showToast(legacy.t(perm === 'denied' ? 'push_blocked' : 'push_toast_err'), 'error');
        return;
      }
      const reg = await this.getReg();
      if (!reg) { legacy.showToast(legacy.t('push_toast_err') + ' (No Service Worker)', 'error'); return; }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.urlBase64ToUint8Array(VAPID_PUBLIC)
        });
      }
      const j = sub.toJSON();
      const db = legacy.db();
      if (!db) throw new Error('db unavailable');
      const res = await db.rpc('save_push_subscription', {
        p_endpoint: j.endpoint,
        p_p256dh: j.keys && j.keys.p256dh,
        p_auth: j.keys && j.keys.auth,
        p_pseudo: legacy.currentPseudo(),
        p_ua: String(navAny().userAgent || '').slice(0, 300)
      });
      if (res && res.error) throw res.error;
      legacy.showToast(legacy.t('push_toast_on'), 'success');
    } catch (e: any) {
      console.error('push enable', e);
      const errMsg = (e && e.message) ? ' (' + e.message + ')' : '';
      legacy.showToast(legacy.t('push_toast_err') + errMsg, 'error');
    } finally {
      this.isEnabling = false;
    }
    this.renderAll();
  }

  private async disable(): Promise<void> {
    try {
      const sub = await this.currentSubscription();
      if (sub) await sub.unsubscribe();
      legacy.showToast(legacy.t('push_toast_off'), 'info');
    } catch (e) {
      console.error('push disable', e);
    }
    this.renderAll();
  }

  private renderAll(): void {
    this.mounted = this.mounted.filter((el) => el && el.isConnected);
    this.mounted.forEach((el) => { void this.render(el); });
  }

  public async render(container: Element | null): Promise<void> {
    if (!container) return;
    const w = winAny();

    if (!this.supported()) {
      const msg = (this.isIOS() && !this.isStandalone()) ? legacy.t('push_ios_hint') : legacy.t('push_unsupported');
      container.innerHTML = '<div class="gm-push-optin gm-dim">' +
        '<i class="ph ph-bell-slash"></i> ' + legacy.esc(msg) + '</div>';
      return;
    }
    if (w.Notification.permission === 'denied') {
      container.innerHTML = '<div class="gm-push-optin gm-dim">' +
        '<i class="ph ph-bell-slash"></i> ' + legacy.esc(legacy.t('push_blocked')) + '</div>';
      return;
    }

    const sub = await this.currentSubscription();
    if (sub && w.Notification.permission === 'granted') {
      container.innerHTML = '<div class="gm-push-optin">' +
        '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-bell-ringing"></i> ' + legacy.esc(legacy.t('push_enabled')) + '</span>' +
        '<button class="gm-btn gm-btn-ghost gm-btn-sm gm-push-off" type="button">' + legacy.esc(legacy.t('push_disable')) + '</button>' +
        '</div>';
      const off = container.querySelector('.gm-push-off');
      if (off) off.addEventListener('click', () => { void this.disable(); });
    } else {
      container.innerHTML = '<div class="gm-push-optin">' +
        '<button class="gm-btn gm-btn-success gm-btn-sm gm-push-on" type="button">' +
          '<i class="ph ph-bell-ringing"></i> ' + legacy.esc(legacy.t('push_enable')) +
        '</button></div>';
      const on = container.querySelector('.gm-push-on');
      if (on) on.addEventListener('click', () => { void this.enable(); });
    }
  }

  public mount(container: Element | null): void {
    if (!container) return;
    if (this.mounted.indexOf(container) === -1) this.mounted.push(container);
    void this.render(container);
  }
}

/** Shared singleton instance (bridged to `window.GM_PUSH` at cutover). */
export const pushService = new PushService();

export default pushService;
