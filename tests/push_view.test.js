/**
 * tests/push_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/push/PushService.ts in jsdom, with
 * stubbed serviceWorker / PushManager / Notification. The legacy root `push.js`
 * is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PushService } from '../src/modules/push/PushService';

let rpcMock;
let registerMock;

function makeReg(sub, subscribeResult) {
  return {
    pushManager: {
      getSubscription: vi.fn(async () => sub),
      subscribe: vi.fn(async () => (subscribeResult !== undefined ? subscribeResult : sub))
    }
  };
}

function makeSub() {
  return {
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'pk', auth: 'au' } }),
    unsubscribe: vi.fn(async () => true)
  };
}

function installGM() {
  rpcMock = vi.fn(async () => ({ error: null }));
  window.GM = {
    t: (k) => k,
    escapeHTML: (s) => String(s ?? ''),
    showToast: vi.fn(),
    getCurrentPseudo: () => 'Alpha',
    db: { rpc: rpcMock }
  };
}

function installPushGlobals(opts = {}) {
  const permission = opts.permission || 'default';
  window.Notification = {
    permission,
    requestPermission: vi.fn(async () => (opts.grantOnRequest ? 'granted' : permission))
  };
  window.PushManager = function PushManager() {};
  const reg = makeReg(opts.sub || null, opts.sub || makeSub());
  registerMock = vi.fn(async () => reg);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register: registerMock }
  });
  return reg;
}

function clearPushGlobals() {
  delete window.Notification;
  delete window.PushManager;
  delete navigator.serviceWorker;
}

function mountContainer() {
  document.body.innerHTML = '<div id="push-slot"></div>';
  return document.getElementById('push-slot');
}

afterEach(() => {
  clearPushGlobals();
  delete window.GM;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PushService — unsupported / blocked states', () => {
  it('shows the unsupported hint when the browser lacks PushManager/Notification', async () => {
    installGM();
    // no serviceWorker / PushManager / Notification installed
    const container = mountContainer();
    const svc = new PushService();
    await svc.render(container);
    expect(container.textContent).toContain('push_unsupported');
  });

  it('shows the blocked hint when Notification.permission is denied', async () => {
    installGM();
    installPushGlobals({ permission: 'denied' });
    const container = mountContainer();
    const svc = new PushService();
    await svc.render(container);
    expect(container.textContent).toContain('push_blocked');
  });
});

describe('PushService — subscribed / opt-in states', () => {
  it('renders the enabled chip + disable button when already subscribed', async () => {
    installGM();
    installPushGlobals({ permission: 'granted', sub: makeSub() });
    const container = mountContainer();
    const svc = new PushService();
    await svc.render(container);
    expect(container.textContent).toContain('push_enabled');
    expect(container.querySelector('.gm-push-off')).toBeTruthy();
  });

  it('renders the opt-in button and subscribes + saves via RPC on click', async () => {
    installGM();
    installPushGlobals({ permission: 'default', grantOnRequest: true, sub: null });
    const container = mountContainer();
    const svc = new PushService();
    svc.mount(container);
    await new Promise((r) => setTimeout(r, 0));

    const on = container.querySelector('.gm-push-on');
    expect(on).toBeTruthy();
    on.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('save_push_subscription', expect.objectContaining({
      p_endpoint: 'https://push.example/abc',
      p_p256dh: 'pk',
      p_auth: 'au',
      p_pseudo: 'Alpha'
    }));
    expect(window.GM.showToast).toHaveBeenCalledWith('push_toast_on', 'success');
  });
});
