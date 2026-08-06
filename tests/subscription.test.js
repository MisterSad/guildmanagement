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

function fromMock() {
    return {
        select: () => ({ order: () => Promise.resolve({ data: GUILDS, error: null }) })
    };
}

let invokeCalls = [];
let assignedUrl = null;

function invokeMock(name, opts) {
    const body = (opts && opts.body) || {};
    invokeCalls.push([name, body]);
    if (name === 'gm-create-order') {
        if (body.action === 'config') {
            return Promise.resolve({ data: { ok: true, mode: 'test', configured: true } });
        }
        if (body.action === 'create') {
            return Promise.resolve({ data: { ok: true, url: 'https://checkout.stripe.test/cs_test_x', sessionId: 'cs_test_x', mode: 'test' } });
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

function setupDb(overrides) {
    GM.db = {
        functions: { invoke: overrides && overrides.invoke ? overrides.invoke : invokeMock },
        from: overrides && overrides.from ? overrides.from : fromMock
    };
}

beforeEach(() => {
    document.body.innerHTML = '<div id="subscription-container"></div>';
    localStorage.setItem('gm_role', 'guild_admin');
    window.currentGuildRestriction = 'ALPHA';
    window.guildsData = {
        ALPHA: { type: 'Premium', end: FUTURE_END, server_number: '1089' }
    };
    invokeCalls = [];
    assignedUrl = null;
    SUB._state.busy = false;
    GM.db = { functions: { invoke: invokeMock }, from: fromMock };
    GM.showToast = vi.fn();
});

afterEach(() => {
    GM.db = null;
    GM.showToast = vi.fn();
    document.body.innerHTML = '';
    delete window.currentGuildRestriction;
    window.history.replaceState({}, '', '/');
});

describe('GM_SUBSCRIPTION self-service subscriptions', () => {
    it('renders the five plans with their prices', async () => {
        await SUB.load();
        const texts = container().textContent;
        expect(planKeys()).toEqual(['1m', '3m', '6m', '12m', 'lifetime']);
        expect(texts).toContain('€6.99');
        expect(texts).toContain('€16.99');
        expect(texts).toContain('€27.99');
        expect(texts).toContain('€47.99');
        expect(texts).toContain('€89.00');
    });

    it('shows the active status for a Premium subscription with a future end', async () => {
        await SUB.load();
        expect(container().textContent).toContain('ALPHA - Active');
        expect(container().textContent).toContain('Active until 2026-12-31');
    });

    it('shows the Lifetime status', async () => {
        window.guildsData.ALPHA = { type: 'Lifetime', end: null, server_number: '' };
        await SUB.load();
        expect(container().textContent).toContain('ALPHA - Lifetime');
        expect(container().textContent).toContain('never expires');
    });

    it('shows the Unlimited status', async () => {
        window.guildsData.ALPHA = { type: 'Unlimited', end: null, server_number: '' };
        await SUB.load();
        expect(container().textContent).toContain('ALPHA - Unlimited');
    });

    it('shows the expired state for a Premium subscription with a past end', async () => {
        window.guildsData.ALPHA = { type: 'Premium', end: '2020-01-01T00:00:00.000Z', server_number: '' };
        await SUB.load();
        expect(container().textContent).toContain('ALPHA - Expired');
        expect(container().textContent).toContain('Renew below');
    });

    it('mentions the accepted payment methods and provider security', async () => {
        await SUB.load();
        const texts = container().textContent;
        expect(texts).toContain('Card, Apple Pay, Google Pay and more');
        expect(texts).toContain('processed and secured by the payment provider');
        expect(texts).toContain('never has access to your bank details');
    });

    it('shows a denied state for non-admin roles', async () => {
        localStorage.setItem('gm_role', 'member');
        delete window.currentGuildRestriction;
        await SUB.load();
        expect(container().textContent).toContain('Admins only');
    });

    it('does not start checkout when payments are not configured', async () => {
        setupDb({
            invoke: async (name, opts) => {
                if ((opts.body || {}).action === 'config') {
                    return { data: { ok: true, mode: 'prod', configured: false } };
                }
                return { data: { ok: false, error: 'not_configured' } };
            }
        });
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="1m"]').click();
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('not configured'), 'error');
        expect(invokeCalls.filter((c) => c[0] === 'gm-create-order' && c[1].action === 'create')).toHaveLength(0);
    });

    it('creates a Checkout Session and redirects the browser to the hosted page', async () => {
        SUB._redirectTo = (url) => { assignedUrl = String(url); };
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="6m"]').click();
        await new Promise((r) => setTimeout(r, 0));
        const createCalls = invokeCalls.filter((c) => c[0] === 'gm-create-order' && c[1].action === 'create');
        expect(createCalls).toHaveLength(1);
        expect(createCalls[0][1].guildId).toBe('ALPHA');
        expect(createCalls[0][1].plan).toBe('6m');
        expect(assignedUrl).toBe('https://checkout.stripe.test/cs_test_x');
    });

    it('shows a failure toast when creating the session fails', async () => {
        setupDb({
            invoke: async (name, opts) => {
                const body = (opts && opts.body) || {};
                if (body.action === 'config') return { data: { ok: true, mode: 'prod', configured: true } };
                if (body.action === 'create') return { data: { ok: false, error: 'checkout_failed' } };
                return { data: { ok: false, error: 'unexpected' } };
            }
        });
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="1m"]').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('Could not start the payment'), 'error');
    });

    it('confirms a successful return by polling gm-order-status and refreshing guildsData', async () => {
        await SUB.load();
        // Simulate the return URL: the app would call handleReturn with the session id.
        await SUB.handleReturn(container(), "?checkout=success&session_id=cs_test_9");
        await new Promise((r) => setTimeout(r, 0));
        const statusCalls = invokeCalls.filter((c) => c[0] === 'gm-order-status');
        expect(statusCalls.length).toBeGreaterThan(0);
        expect(statusCalls[0][1].sessionId).toBe('cs_test_9');
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('activated'), 'success');
    });

    it('shows a waiting toast when the payment is not applied yet', async () => {
        vi.useFakeTimers();
        setupDb({
            invoke: async (name, opts) => {
                const body = (opts && opts.body) || {};
                if (name === 'gm-create-order' && body.action === 'config') {
                    return { data: { ok: true, mode: 'test', configured: true } };
                }
                if (name === 'gm-order-status') {
                    return { data: { ok: true, state: 'open', applied: false } };
                }
                return { data: { ok: false, error: 'unexpected_invoke' } };
            },
            from: fromMock
        });
        await SUB.load();
        const pending = SUB.handleReturn(container(), "?checkout=success&session_id=cs_test_9");
        await vi.advanceTimersByTimeAsync(2000 * 16);
        await pending;
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('activation in progress'), 'info');
        vi.useRealTimers();
    });

    it('shows the load error state with a retry button when config fails', async () => {
        setupDb({ invoke: async () => ({ data: { ok: false, error: 'server_error' } }) });
        await SUB.load();
        expect(container().textContent).toContain('Could not load the subscription page');
        expect(document.getElementById('subscription-retry')).not.toBeNull();
    });
});
