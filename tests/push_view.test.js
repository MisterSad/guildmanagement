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

describe('PushService — decommissioned inert stub', () => {
  it('safely no-ops on init, render, and mount', async () => {
    const svc = new PushService();
    svc.init();
    const container = mountContainer();
    await svc.render(container);
    expect(container.innerHTML).toBe('');
    svc.mount(container);
    expect(container.innerHTML).toBe('');
  });
});
