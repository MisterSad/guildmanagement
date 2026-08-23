import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Pure validation logic mirroring member-portal and subscription tiers
const DONATION_TIERS = {
    donation_2: 200,
    donation_5: 500,
    donation_10: 1000,
};

function validateDonationAmount(plan, amountCents) {
    if (DONATION_TIERS[plan]) {
        return { valid: true, cents: DONATION_TIERS[plan], key: plan };
    }
    if (plan === 'donation_custom') {
        const amt = Number(amountCents);
        if (!Number.isInteger(amt) || amt < 200 || amt > 10000) {
            return { valid: false, error: 'invalid_amount' };
        }
        return { valid: true, cents: amt, key: 'donation_custom' };
    }
    return { valid: false, error: 'invalid_amount' };
}

function parseCheckoutReturnParams(search) {
    const params = new URLSearchParams(search);
    const checkout = params.get('checkout');
    const sessionId = params.get('session_id');
    return {
        isCheckoutReturn: checkout === 'success' || checkout === 'cancel',
        isSuccess: checkout === 'success',
        isCancel: checkout === 'cancel',
        sessionId: sessionId || null,
    };
}

function determineCheckoutReturnDestination(role, isPortalFlag) {
    if (role === 'member' || isPortalFlag) {
        return 'portal_donation';
    }
    return 'cc_subscription';
}

describe('Voluntary Donation Pure Logic & Bounding (v127.0)', () => {
    describe('Donation tier mapping', () => {
        it('resolves preset donation tiers to correct cent amounts', () => {
            expect(validateDonationAmount('donation_2')).toEqual({ valid: true, cents: 200, key: 'donation_2' });
            expect(validateDonationAmount('donation_5')).toEqual({ valid: true, cents: 500, key: 'donation_5' });
            expect(validateDonationAmount('donation_10')).toEqual({ valid: true, cents: 1000, key: 'donation_10' });
        });

        it('rejects unknown preset plan names', () => {
            expect(validateDonationAmount('donation_50')).toEqual({ valid: false, error: 'invalid_amount' });
            expect(validateDonationAmount('1m')).toEqual({ valid: false, error: 'invalid_amount' });
            expect(validateDonationAmount('')).toEqual({ valid: false, error: 'invalid_amount' });
        });
    });

    describe('Custom amount bounding (EUR 2.00 min to EUR 100.00 max)', () => {
        it('accepts exact lower bound of 200 cents (EUR 2)', () => {
            expect(validateDonationAmount('donation_custom', 200)).toEqual({
                valid: true,
                cents: 200,
                key: 'donation_custom'
            });
        });

        it('accepts exact upper bound of 10000 cents (EUR 100)', () => {
            expect(validateDonationAmount('donation_custom', 10000)).toEqual({
                valid: true,
                cents: 10000,
                key: 'donation_custom'
            });
        });

        it('accepts intermediate amounts (e.g. 2500 cents = EUR 25)', () => {
            expect(validateDonationAmount('donation_custom', 2500)).toEqual({
                valid: true,
                cents: 2500,
                key: 'donation_custom'
            });
        });

        it('rejects values below lower bound (199 cents / 0 / negative)', () => {
            expect(validateDonationAmount('donation_custom', 199)).toEqual({ valid: false, error: 'invalid_amount' });
            expect(validateDonationAmount('donation_custom', 0)).toEqual({ valid: false, error: 'invalid_amount' });
            expect(validateDonationAmount('donation_custom', -500)).toEqual({ valid: false, error: 'invalid_amount' });
        });

        it('rejects values above upper bound (10001 cents / large amounts)', () => {
            expect(validateDonationAmount('donation_custom', 10001)).toEqual({ valid: false, error: 'invalid_amount' });
            expect(validateDonationAmount('donation_custom', 50000)).toEqual({ valid: false, error: 'invalid_amount' });
        });

        it('rejects non-integer / floating-point cents inputs', () => {
            expect(validateDonationAmount('donation_custom', 250.5)).toEqual({ valid: false, error: 'invalid_amount' });
            expect(validateDonationAmount('donation_custom', NaN)).toEqual({ valid: false, error: 'invalid_amount' });
        });
    });

    describe('Checkout return URL parameter parsing', () => {
        it('parses success return URL with session_id', () => {
            const parsed = parseCheckoutReturnParams('?checkout=success&session_id=cs_test_12345');
            expect(parsed.isCheckoutReturn).toBe(true);
            expect(parsed.isSuccess).toBe(true);
            expect(parsed.isCancel).toBe(false);
            expect(parsed.sessionId).toBe('cs_test_12345');
        });

        it('parses cancel return URL', () => {
            const parsed = parseCheckoutReturnParams('?checkout=cancel');
            expect(parsed.isCheckoutReturn).toBe(true);
            expect(parsed.isSuccess).toBe(false);
            expect(parsed.isCancel).toBe(true);
            expect(parsed.sessionId).toBeNull();
        });

        it('ignores normal URLs without checkout parameters', () => {
            const parsed = parseCheckoutReturnParams('?tab=overview');
            expect(parsed.isCheckoutReturn).toBe(false);
            expect(parsed.isSuccess).toBe(false);
            expect(parsed.isCancel).toBe(false);
        });
    });

    describe('Routing decision function (Player Portal vs Command Center)', () => {
        it('routes members and portal sessions to Player Portal donation panel', () => {
            expect(determineCheckoutReturnDestination('member', false)).toBe('portal_donation');
            expect(determineCheckoutReturnDestination('guild_admin', true)).toBe('portal_donation');
        });

        it('routes admin sessions to Command Center donation tab', () => {
            expect(determineCheckoutReturnDestination('guild_admin', false)).toBe('cc_subscription');
            expect(determineCheckoutReturnDestination('super_admin', false)).toBe('cc_subscription');
            expect(determineCheckoutReturnDestination('server_admin', false)).toBe('cc_subscription');
        });
    });

    describe('Containment verification for v127.0 Free App & Donation architecture', () => {
        it('verifies migration 20260824000000 contains is_subscription_active returning true, kind column, and gm_apply_donation', () => {
            const migPath = path.resolve(__dirname, '../supabase/migrations/20260824000000_free_app_and_donations.sql');
            expect(fs.existsSync(migPath)).toBe(true);
            const content = fs.readFileSync(migPath, 'utf-8');
            expect(content).toContain('SELECT true;');
            expect(content).toContain("kind text NOT NULL DEFAULT 'subscription'");
            expect(content).toContain('CREATE OR REPLACE FUNCTION public.gm_apply_donation');
            expect(content).toContain('GRANT EXECUTE ON FUNCTION public.gm_apply_donation(text) TO service_role;');
        });

        it('verifies member-portal contains create-donation action and donations_disabled rejection', () => {
            const portalEdgePath = path.resolve(__dirname, '../supabase/functions/member-portal/index.ts');
            const content = fs.readFileSync(portalEdgePath, 'utf-8');
            expect(content).toContain('if (action === "create-donation")');
            expect(content).toContain('error: "donations_disabled"');
            expect(content).toContain('createDonationCheckoutSession');
            expect(content).toContain('kind: "donation"');
        });

        it('verifies gm-stripe-webhook branches on payment kind and calls gm_apply_donation', () => {
            const webhookPath = path.resolve(__dirname, '../supabase/functions/gm-stripe-webhook/index.ts');
            const content = fs.readFileSync(webhookPath, 'utf-8');
            expect(content).toContain('isDonation');
            expect(content).toContain('gm_apply_donation');
            expect(content).toContain('gm_apply_subscription_payment');
        });
    });
});
