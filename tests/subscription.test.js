import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/modules/subscription/subscription-view.ts';

const GM = window.GM;
const SUB = window.GM_SUBSCRIPTION;

const GUILDS = [
    { id: 'ALPHA', subscription_type: 'Unlimited', subscription_end: null, server_number: '1089' },
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
    }
    if (name === 'member-portal') {
        if (body.action === 'create-donation') {
            return Promise.resolve({ data: { ok: true, url: 'https://checkout.stripe.test/cs_donation_x', sessionId: 'cs_donation_x' } });
        }
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
        ALPHA: { type: 'Unlimited', end: null, server_number: '1089' }
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

describe('GM_SUBSCRIPTION voluntary donations ("Buy Me a Coffee")', () => {
    it('renders the three donation tiers with their prices (€2, €5, €10)', async () => {
        await SUB.load();
        const texts = container().textContent;
        expect(planKeys()).toEqual(['donation_2', 'donation_5', 'donation_10']);
        expect(texts).toContain('€2');
        expect(texts).toContain('€5');
        expect(texts).toContain('€10');
        expect(texts).toContain('100% FREE');
    });

    it('renders the custom donation amount card and input elements', async () => {
        await SUB.load();
        const customInput = container().querySelector('#donation-custom-input');
        const customBtn = container().querySelector('#donation-custom-btn');
        expect(customInput).not.toBeNull();
        expect(customBtn).not.toBeNull();
        expect(container().textContent).toContain('Custom amount');
        expect(container().textContent).toContain('between €2 and €100');
    });

    it('renders the transparency section explaining real infrastructure and AI OCR costs', async () => {
        await SUB.load();
        const texts = container().textContent;
        expect(texts).toContain('Why your support matters');
        expect(texts).toContain('This app is free, and it stays free. But it is not free to run:');
        expect(texts).toContain('Hosting & infrastructure: roughly EUR 45-100 every month');
        expect(texts).toContain('AI OCR scans: every screenshot you analyze calls a paid AI API');
        expect(texts).toContain('Every coffee genuinely helps. Thank you!');
    });

    it('mentions that payments are secured and managed by Stripe with Terms & Conditions link', async () => {
        await SUB.load();
        const texts = container().textContent;
        expect(texts).toContain('All payments are securely processed and managed by Stripe.');
        expect(texts).toContain('Terms & Conditions');
    });

    it('shows a denied state for non-admin roles in Command Center', async () => {
        localStorage.setItem('gm_role', 'member');
        delete window.currentGuildRestriction;
        await SUB.load();
        expect(container().textContent).toContain('Admins only');
    });

    it('regression: server_admin is not denied (was silently excluded by an allowlist of just super_admin/guild_admin)', async () => {
        // Reported live via a screenshot: a real server_admin clicked the
        // "Buy Me a Coffee" link (correctly visible after the shell.js nav
        // fix) and landed on this exact "Admins only" denial -- this module
        // has its own separate role gate that had the identical bug,
        // independently, since it never imported/reused shell.js's check.
        localStorage.setItem('gm_role', 'server_admin');
        await SUB.load();
        expect(container().textContent).not.toContain('Admins only');
        expect(planKeys()).toEqual(['donation_2', 'donation_5', 'donation_10']);
    });

    it('shows a donations-disabled state when the guild flag is set', async () => {
        window.guildsData.ALPHA = { type: 'Unlimited', end: null, server_number: '1089', paymentsDisabled: true };
        await SUB.load();
        expect(container().textContent).toContain('Donations are disabled');
        expect(container().textContent).toContain('Donations are disabled on the demonstration server.');
        expect(planKeys()).toEqual([]);
        expect(invokeCalls.filter((c) => c[0] === 'member-portal')).toHaveLength(0);
    });

    it('does not start checkout when payments are not configured', async () => {
        setupDb({
            invoke: async (name, opts) => {
                if (name === 'gm-create-order' && (opts.body || {}).action === 'config') {
                    return { data: { ok: true, mode: 'prod', configured: false } };
                }
                return { data: { ok: false, error: 'not_configured' } };
            }
        });
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="donation_2"]').click();
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('not configured'), 'error');
        expect(invokeCalls.filter((c) => c[0] === 'member-portal')).toHaveLength(0);
    });

    it('creates a Donation Checkout Session via member-portal and redirects the browser', async () => {
        SUB._redirectTo = (url) => { assignedUrl = String(url); };
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="donation_5"]').click();
        await new Promise((r) => setTimeout(r, 0));
        const donateCalls = invokeCalls.filter((c) => c[0] === 'member-portal' && c[1].action === 'create-donation');
        expect(donateCalls).toHaveLength(1);
        expect(donateCalls[0][1].payload.guildId).toBe('ALPHA');
        expect(donateCalls[0][1].payload.plan).toBe('donation_5');
        expect(assignedUrl).toBe('https://checkout.stripe.test/cs_donation_x');
    });

    it('creates a custom Donation Checkout Session when valid custom amount is entered', async () => {
        SUB._redirectTo = (url) => { assignedUrl = String(url); };
        await SUB.load();
        const customInput = container().querySelector('#donation-custom-input');
        const customBtn = container().querySelector('#donation-custom-btn');
        customInput.value = '25';
        customBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        const donateCalls = invokeCalls.filter((c) => c[0] === 'member-portal' && c[1].action === 'create-donation');
        expect(donateCalls).toHaveLength(1);
        expect(donateCalls[0][1].payload.plan).toBe('donation_custom');
        expect(donateCalls[0][1].payload.amountCents).toBe(2500);
        expect(assignedUrl).toBe('https://checkout.stripe.test/cs_donation_x');
    });

    it('blocks client-side submission of invalid custom amounts (<2 or >100 EUR)', async () => {
        await SUB.load();
        const customInput = container().querySelector('#donation-custom-input');
        const customBtn = container().querySelector('#donation-custom-btn');
        const customErr = container().querySelector('#donation-custom-error');

        // Test < 2
        customInput.value = '1';
        customBtn.click();
        expect(customErr.style.display).toBe('block');
        expect(invokeCalls.filter((c) => c[0] === 'member-portal')).toHaveLength(0);

        // Test > 100
        customInput.value = '150';
        customBtn.click();
        expect(customErr.style.display).toBe('block');
        expect(invokeCalls.filter((c) => c[0] === 'member-portal')).toHaveLength(0);
    });

    it('shows a failure toast when creating the donation session fails', async () => {
        setupDb({
            invoke: async (name, opts) => {
                const body = (opts && opts.body) || {};
                if (name === 'gm-create-order' && body.action === 'config') return { data: { ok: true, mode: 'prod', configured: true } };
                if (name === 'member-portal' && body.action === 'create-donation') return { data: { ok: false, error: 'checkout_failed' } };
                return { data: { ok: false, error: 'unexpected' } };
            }
        });
        await SUB.load();
        container().querySelector('[data-gm-sub-plan="donation_2"]').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('Could not start the donation checkout'), 'error');
    });

    it('shows a warm thank-you state on successful return (?checkout=success) without polling', async () => {
        await SUB.load();
        await SUB.handleReturn(container(), "?checkout=success&session_id=cs_test_donation");
        await new Promise((r) => setTimeout(r, 0));
        expect(container().textContent).toContain('Thank you for your support!');
        expect(container().textContent).toContain('Your donation helps keep the servers running');
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('Thank you for your support!'), 'success');
        // Verify NO gm-order-status polling is executed for voluntary donations
        const statusCalls = invokeCalls.filter((c) => c[0] === 'gm-order-status');
        expect(statusCalls).toHaveLength(0);
    });

    it('handles cancelled return (?checkout=cancel) with an info toast', async () => {
        await SUB.load();
        await SUB.handleReturn(container(), "?checkout=cancel");
        expect(GM.showToast).toHaveBeenCalledWith(expect.stringContaining('Donation cancelled.'), 'info');
    });

    it('shows the load error state with a retry button when config fails', async () => {
        setupDb({ invoke: async () => ({ data: { ok: false, error: 'server_error' } }) });
        await SUB.load();
        expect(container().textContent).toContain('Could not load the donation page');
        expect(document.getElementById('subscription-retry')).not.toBeNull();
    });
});
