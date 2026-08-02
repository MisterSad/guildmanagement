import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../subscription.js';

const GM = window.GM;
const SUB = window.GM_SUBSCRIPTION;

const FUTURE_END = '2026-12-31T00:00:00.000Z';
const GUILDS = [
    { id: 'ALPHA', subscription_type: 'Premium', subscription_end: FUTURE_END, server_number: '1089' },
    { id: 'OMEGA', subscription_type: 'Unlimited', subscription_end: null, server_number: null },
];

let capturedOpts = null;

function fromMock() {
    return {
        select: () => ({ order: () => Promise.resolve({ data: GUILDS, error: null }) })
    };
}

function invokeMock(name, opts) {
    const body = (opts && opts.body) || {};
    if (name === 'gm-create-order') {
        if (body.action === 'config') {
            return Promise.resolve({ data: { ok: true, publicKey: 'pk_test_123', mode: 'sandbox', configured: true } });
        }
        if (body.action === 'create') {
            return Promise.resolve({ data: { ok: true, token: 'tok_x', orderId: 'ord_x', publicKey: 'pk_test_123', mode: 'sandbox' } });
        }
    }
    if (name === 'gm-order-status') {
        return Promise.resolve({ data: { ok: true, state: 'completed', applied: true, lifetime: false, newEnd: FUTURE_END, planKey: '1m' } });
    }
    return Promise.resolve({ data: { ok: false, error: 'unexpected_invoke' } });
}

function container() {
    return document.getElementById('subscription-container');
}

function planKeys() {
    return Array.prototype.map.call(
        container().querySelectorAll('[data-gm-sub-plan]'),
        (el) => el.getAttribute('data-gm-sub-plan')
    );
}

beforeEach(() => {
    document.body.innerHTML = '<div id="subscription-container"></div>';
    localStorage.setItem('gm_role', 'guild_admin');
    window.currentGuildRestriction = 'ALPHA';
    window.guildsData = {
        ALPHA: { type: 'Premium', end: FUTURE_END, server_number: '1089' }
    };
    capturedOpts = null;
    window.RevolutCheckout = {
        embeddedCheckout: async (opts) => {
            capturedOpts = opts;
            return { destroy: vi.fn() };
        }
    };
    GM.db = { functions: { invoke: invokeMock }, from: fromMock };
    GM.showToast = vi.fn();
});

afterEach(() => {
    GM.db = null;
    GM.showToast = vi.fn();
    document.body.innerHTML = '';
    delete window.RevolutCheckout;
    delete window.currentGuildRestriction;
});

describe('GM_SUBSCRIPTION self-service subscriptions', () => {
    it('renders the four plans with their prices', async () => {
        await SUB.load();
        const texts = container().textContent;
        expect(planKeys()).toEqual(['1m', '3m', '6m', 'lifetime']);
        expect(texts).toContain('€6.99');
        expect(texts).toContain('€16.99');
        expect(texts).toContain('€27.99');
        expect(texts).toContain('€89.00');
    });

    it('shows the active status for a Premium subscription with a future end', async () => {
        await SUB.load();
        expect(container().textContent).toContain('ALPHA — Active');
        expect(container().textContent).toContain('Active until 2026-12-31');
    });

    it('shows the Lifetime status', async () => {
        window.guildsData.ALPHA = { type: 'Lifetime', end: null, server_number: '' };
        await SUB.load();
        expect(container().textContent).toContain('ALPHA — Lifetime');
        expect(container().textContent).toContain('never expires');
    });

    it('shows the Unlimited status', async () => {
        window.guildsData.ALPHA = { type: 'Unlimited', end: null, server_number: '' };
        await SUB.load();
        expect(container().textContent).toContain('ALPHA — Unlimited');
    });

    it('shows the expired state for a Premium subscription with a past end', async () => {
        window.guildsData.ALPHA = { type: 'Premium', end: '2020-01-01T00:00:00.000Z', server_number: '' };
        await SUB.load();
        expect(container().textContent).toContain('ALPHA — Expired');
        expect(container().textContent).toContain('Renew below');
    });

    it('shows a denied state for non-admin roles', async () => {
        localStorage.setItem('gm_role', 'member');
        delete window.currentGuildRestriction;
        await SUB.load();
        expect(container().textContent).toContain('Admins only');
    });

    it('does not open the widget when payments are not configured', async () => {
        GM.db = {
            functions: {
                invoke: async (name, opts) => {
                    if ((opts.body || {}).action === 'config') {
                        return { data: { ok: true, publicKey: null, mode: 'prod', configured: false } };
                    }
                    return { data: { ok: false, error: 'not_configured' } };
                }
            },
            from: fromMock
        };
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="1m"]').click();
        expect(capturedOpts).toBeNull();
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('not configured'), 'error');
    });

    it('opens the embedded checkout with the config public key and mode', async () => {
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="6m"]').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(capturedOpts).not.toBeNull();
        expect(capturedOpts.publicToken).toBe('pk_test_123');
        expect(capturedOpts.mode).toBe('sandbox');
        expect(typeof capturedOpts.createOrder).toBe('function');
    });

    it('createOrder creates the order with the current guild and plan and returns the token', async () => {
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="6m"]').click();
        await new Promise((r) => setTimeout(r, 0));
        const created = await capturedOpts.createOrder();
        expect(created).toEqual({ publicId: 'tok_x' });
    });

    it('shows a payment failure toast on onError', async () => {
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="1m"]').click();
        await new Promise((r) => setTimeout(r, 0));
        capturedOpts.onError({ error: { message: 'declined' }, orderId: 'tok_x' });
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('Payment failed'), 'error');
    });

    it('confirms the payment, refreshes guildsData and shows the success toast', async () => {
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="1m"]').click();
        await new Promise((r) => setTimeout(r, 0));
        await capturedOpts.onSuccess({ orderId: 'tok_x' });
        await new Promise((r) => setTimeout(r, 0));
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('activated'), 'success');
        expect(window.guildsData.ALPHA.end).toBe(FUTURE_END);
        expect(document.getElementById('subscription-widget').style.display).toBe('none');
    });

    it('shows a waiting toast when Revolut has not applied the payment yet', async () => {
        vi.useFakeTimers();
        GM.db = {
            functions: {
                invoke: async (name, opts) => {
                    const body = (opts && opts.body) || {};
                    if (name === 'gm-create-order' && body.action === 'config') {
                        return { data: { ok: true, publicKey: 'pk_test_123', mode: 'sandbox', configured: true } };
                    }
                    if (name === 'gm-order-status') {
                        return { data: { ok: true, state: 'pending', applied: false } };
                    }
                    return { data: { ok: false, error: 'unexpected_invoke' } };
                }
            },
            from: fromMock
        };
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="3m"]').click();
        await Promise.resolve();
        capturedOpts.onSuccess({ orderId: 'tok_y' });
        await vi.advanceTimersByTimeAsync(2000 * 16);
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('activation in progress'), 'info');
        vi.useRealTimers();
    });

    it('shows the load error state with a retry button when config fails', async () => {
        GM.db = {
            functions: { invoke: async () => ({ data: { ok: false, error: 'server_error' } }) },
            from: fromMock
        };
        await SUB.load();
        expect(container().textContent).toContain('Could not load the subscription page');
        expect(document.getElementById('subscription-retry')).not.toBeNull();
    });
});
