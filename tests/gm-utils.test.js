import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';

const GM = window.GM;

function setStorage(map) {
    Object.keys(map).forEach((k) => localStorage.setItem(k, map[k]));
}

function clearStorage() {
    localStorage.clear();
}

describe('isGuildSubscriptionExpired (subscription gating)', () => {
    beforeEach(() => {
        clearStorage();
        window.currentGuildRestriction = null;
        window.guildsData = {
            ALPHA: { type: 'Unlimited' },
            OMEGA: { type: 'Premium', end: new Date(Date.now() + 86400000).toISOString() },
            IMK: { type: 'Premium', end: new Date(Date.now() - 86400000).toISOString() },
            BABE: { type: 'Premium' },
            SOLO: { type: 'Standard' },
        };
    });

    it('is never expired for super_admin', () => {
        setStorage({ gm_role: 'super_admin' });
        expect(GM.isGuildSubscriptionExpired('IMK')).toBe(false);
    });

    it('is never expired when unrestricted', () => {
        setStorage({ gm_role: 'member' });
        expect(GM.isGuildSubscriptionExpired('IMK')).toBe(false);
    });

    it('returns false without a guild id', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired()).toBe(false);
    });

    it('returns false for unknown guilds and missing data', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired('NOPE')).toBe(false);
        delete window.guildsData.ALPHA;
        expect(GM.isGuildSubscriptionExpired('ALPHA')).toBe(false);
    });

    it('Unlimited subscriptions never expire', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired('ALPHA')).toBe(false);
    });

    it('Premium with a future end date is active', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired('OMEGA')).toBe(false);
    });

    it('Premium with a past end date is expired', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired('IMK')).toBe(true);
    });

    it('Premium without an end date is treated as expired', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired('BABE')).toBe(true);
    });

    it('Standard subscriptions do not expire', () => {
        setStorage({ gm_role: 'member' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.isGuildSubscriptionExpired('SOLO')).toBe(false);
    });
});

describe('guild config (localStorage + DB fallback)', () => {
    beforeEach(() => {
        clearStorage();
        window.currentGuildRestriction = null;
        window.currentGuild = 'ALPHA';
        GM.db = null;
    });

    afterEach(() => {
        GM.db = null;
    });

    it('getGuildConfig returns the stored localStorage value', async () => {
        setStorage({ gm_config_ALPHA_mykey: 'myvalue' });
        expect(await GM.config.get('mykey')).toBe('myvalue');
    });

    it('getGuildConfig falls back to built-in defaults for known keys', async () => {
        expect(await GM.config.get('coeff_svs')).toBe('5');
        expect(await GM.config.get('coeff_armsrace')).toBe('1');
    });

    it('getGuildConfig returns empty string for unknown keys', async () => {
        expect(await GM.config.get('nope_nope')).toBe('');
    });

    it('setGuildConfig persists to localStorage', async () => {
        await GM.config.set('coeff_gvg', '7');
        expect(localStorage.getItem('gm_config_ALPHA_coeff_gvg')).toBe('7');
    });

    it('getGuildConfig prefers the DB when a client is present', async () => {
        let upserted = null;
        const eqBuilder = {
            eq: () => eqBuilder,
            maybeSingle: async () => ({ data: { value: 'from-db' }, error: null }),
        };
        GM.db = {
            from: (table) => ({
                select: () => ({
                    eq: () => eqBuilder,
                }),
                upsert: async (row) => {
                    upserted = row;
                    return { error: null };
                },
            }),
        };
        expect(await GM.config.get('coeff_svs')).toBe('from-db');
        await GM.config.set('coeff_svs', '9');
        expect(upserted.value).toBe('9');
        expect(upserted.guild).toBe('ALPHA');
        expect(localStorage.getItem('gm_config_ALPHA_coeff_svs')).toBe('9');
    });

    it('getGuildConfig falls back to localStorage when the DB errors', async () => {
        setStorage({ gm_config_ALPHA_coeff_svs: '3' });
        GM.db = {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
                    }),
                }),
            }),
        };
        expect(await GM.config.get('coeff_svs')).toBe('3');
    });
});

describe('forceRefreshPortalSession (refresh-token fallback)', () => {
    beforeEach(() => {
        clearStorage();
        window.currentGuildRestriction = null;
        window.currentGuild = 'ALPHA';
        GM.db = null;
    });

    afterEach(() => {
        GM.db = null;
        delete globalThis.fetch;
    });

    it('returns null when no session is stored', async () => {
        expect(await GM.forceRefreshPortalSession()).toBeNull();
    });

    it('returns null when supabase-js storage entry is missing', async () => {
        setStorage({ some_other_key: 'x' });
        expect(await GM.forceRefreshPortalSession()).toBeNull();
    });

    it('exchanges the stored refresh token and re-injects the session', async () => {
        setStorage({
            'sb-vgweufzwmfwplusskmuf-auth-token': JSON.stringify({
                access_token: 'old.access.token',
                refresh_token: 'rt-abc'
            })
        });

        let setSessionArgs = null;
        GM.db = {
            auth: {
                setSession: async (args) => {
                    setSessionArgs = args;
                    return { error: null };
                }
            }
        };

        const makeJwt = (payload) => {
            const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return 'header.' + b64(payload) + '.sig';
        };

        globalThis.fetch = async () => ({
            json: async () => ({
                access_token: makeJwt({ app_metadata: { app_role: 'member', account_id: 'HawkEyePlayer' } }),
                refresh_token: 'rt-new'
            })
        });

        const info = await GM.forceRefreshPortalSession();
        expect(info).toEqual({ role: 'member', accountId: 'HawkEyePlayer' });
        expect(setSessionArgs).toEqual({
            access_token: expect.stringContaining('.'),
            refresh_token: 'rt-new'
        });
    });

    it('returns null when the refresh endpoint fails', async () => {
        setStorage({
            'sb-vgweufzwmfwplusskmuf-auth-token': JSON.stringify({
                access_token: 'a.b.c',
                refresh_token: 'rt-bad'
            })
        });
        GM.db = { auth: { setSession: async () => ({ error: null }) } };

        globalThis.fetch = async () => ({ json: async () => ({ error: 'invalid_grant' }) });
        expect(await GM.forceRefreshPortalSession()).toBeNull();
    });
});

describe('localStorage rad_* → gm_* migration shim', () => {
    it('migrates legacy keys on load and removes the originals', async () => {
        clearStorage();
        setStorage({ rad_role: 'R4', rad_current_guild: 'IMK', rad_config_ALPHA_x: '1' });
        await import('../gm-utils.js?shim-test=' + Math.random());
        expect(localStorage.getItem('gm_role')).toBe('R4');
        expect(localStorage.getItem('gm_current_guild')).toBe('IMK');
        expect(localStorage.getItem('gm_config_ALPHA_x')).toBe('1');
        expect(localStorage.getItem('rad_role')).toBeNull();
        expect(localStorage.getItem('rad_current_guild')).toBeNull();
    });
});
