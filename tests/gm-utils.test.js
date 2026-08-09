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

describe('isPaymentsDisabled (per-guild payments switch)', () => {
    beforeEach(() => {
        clearStorage();
        window.currentGuildRestriction = null;
        window.guildsData = {
            ALPHA: { type: 'Unlimited', paymentsDisabled: false },
            DEMO: { type: 'Unlimited', paymentsDisabled: true },
        };
    });

    it('returns false when the guild has no disabled flag', () => {
        expect(GM.isPaymentsDisabled('ALPHA')).toBe(false);
        expect(GM.isPaymentsDisabled('NOPE')).toBe(false);
    });

    it('returns true for a guild with payments disabled', () => {
        expect(GM.isPaymentsDisabled('DEMO')).toBe(true);
    });

    it('falls back to the active guild when no id is given', () => {
        window.currentGuild = 'DEMO';
        expect(GM.isPaymentsDisabled()).toBe(true);
        window.currentGuild = 'ALPHA';
        expect(GM.isPaymentsDisabled()).toBe(false);
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

describe('canWriteGuild (role-based write access)', () => {
    beforeEach(() => {
        clearStorage();
        window.currentGuildRestriction = null;
        window.currentGuild = 'ALPHA';
        window.guildsData = {
            ALPHA: { type: 'Unlimited' },
            OMEGA: { type: 'Unlimited' },
            IMK: { type: 'Premium', end: new Date(Date.now() + 86400000).toISOString() },
            BABE: { type: 'Premium', end: new Date(Date.now() - 86400000).toISOString() },
        };
    });

    it('super_admin can write to every guild', () => {
        setStorage({ gm_role: 'super_admin' });
        expect(GM.canWriteGuild('ALPHA')).toBe(true);
        expect(GM.canWriteGuild('OMEGA')).toBe(true);
        expect(GM.canWriteGuild('IMK')).toBe(true);
    });

    it('guild_admin can write to their own guild when the subscription is active', () => {
        setStorage({ gm_role: 'guild_admin' });
        window.currentGuildRestriction = 'IMK';
        expect(GM.canWriteGuild('IMK')).toBe(true);
        expect(GM.canWriteGuild('ALPHA')).toBe(false);
    });

    it('guild_admin cannot write when the subscription is expired', () => {
        setStorage({ gm_role: 'guild_admin' });
        window.currentGuildRestriction = 'BABE';
        expect(GM.canWriteGuild('BABE')).toBe(false);
    });

    it('guild_admin cannot write when the restriction is missing (no fallback)', () => {
        setStorage({ gm_role: 'guild_admin' });
        window.currentGuildRestriction = null;
        window.currentGuild = 'OMEGA';
        expect(GM.canWriteGuild('OMEGA')).toBe(false);
    });

    it('guild_admin cannot write to a different guild', () => {
        setStorage({ gm_role: 'guild_admin' });
        window.currentGuildRestriction = 'OMEGA';
        expect(GM.canWriteGuild('ALPHA')).toBe(false);
    });

    it('member can never write', () => {
        setStorage({ gm_role: 'member' });
        expect(GM.canWriteGuild('ALPHA')).toBe(false);
        expect(GM.canWriteGuild('OMEGA')).toBe(false);
    });
});

describe('buildEventSessionId (deterministic event ids, all tenants)', () => {
    it('weekly events use the ISO week of the battle date', () => {
        expect(GM.buildEventSessionId('SvS', '2026-08-03T19:00:00Z')).toBe('SVS-2026-W32');
        expect(GM.buildEventSessionId('GvG', '2026-08-03T00:00:00Z')).toBe('GVG-2026-W32');
        expect(GM.buildEventSessionId('Glory', '2026-08-03T12:00:00Z')).toBe('GLORY-2026-W32');
        expect(GM.buildEventSessionId('SvS', '2026-08-02T18:00:00Z')).toBe('SVS-2026-W31');
    });

    it('dated events use YYYYMMDD of the battle date with sequence suffix -1 when no existing ids', () => {
        // No existingIds -> first session gets suffix -1
        expect(GM.buildEventSessionId('ARMS RACE STAGE A', '2026-08-09T12:00:00Z', [])).toBe('ARA-20260809-1');
        expect(GM.buildEventSessionId('ARMS RACE STAGE B', '2026-08-09T12:00:00Z', [])).toBe('ARB-20260809-1');
        expect(GM.buildEventSessionId('Defend Trade Route', '2026-08-08T19:30:00Z', [])).toBe('DTR-20260808-1');
        // Second session on the same day gets -2
        expect(GM.buildEventSessionId('Defend Trade Route', '2026-08-08T19:30:00Z', ['DTR-20260808-1'])).toBe('DTR-20260808-2');
        // Third session skips to -3 if -2 is also taken
        expect(GM.buildEventSessionId('Defend Trade Route', '2026-08-08T19:30:00Z', ['DTR-20260808-1', 'DTR-20260808-2'])).toBe('DTR-20260808-3');
    });

    it('shadowfront squads get their own prefix and sequence suffix', () => {
        expect(GM.buildEventSessionId('Shadowfront Squad 1', '2026-08-02T12:00:00Z', [])).toBe('SF1-20260802-1');
        expect(GM.buildEventSessionId('Shadowfront Squad 2', '2026-08-05T12:00:00Z', [])).toBe('SF2-20260805-1');
        // Collision avoidance
        expect(GM.buildEventSessionId('Shadowfront Squad 1', '2026-08-02T12:00:00Z', ['SF1-20260802-1'])).toBe('SF1-20260802-2');
    });

    it('the same battle date yields the same id (re-start reuses the session)', () => {
        // With the same existingIds, both calls get the same first available slot
        const a = GM.buildEventSessionId('ARMS RACE STAGE A', '2026-08-09T12:00:00Z', []);
        const b = GM.buildEventSessionId('ARMS RACE STAGE A', '2026-08-09T18:00:00Z', []);
        expect(a).toBe(b); // Both -> ARA-20260809-1
    });

    it('unknown event names fall back to a timestamp', () => {
        expect(GM.buildEventSessionId('Something Else')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});

describe('eventScoringKey (participation counted once per week for weekly events)', () => {
    it('Arms Race Stage A and B are separate events keyed by session', () => {
        expect(GM.eventScoringKey('ARMS RACE STAGE A', 'ARA-20260805', '2026-08-03'))
            .toBe('Arms Race|ARA-20260805');
        expect(GM.eventScoringKey('ARMS RACE STAGE B', 'ARB-20260805', '2026-08-03'))
            .toBe('Arms Race|ARB-20260805');
        expect(GM.eventScoringKey('ARMS RACE STAGE A', 'ARA-20260805', '2026-08-03'))
            .not.toBe(GM.eventScoringKey('ARMS RACE STAGE A', 'ARA-20260808', '2026-08-03'));
    });

    it('Shadowfront squads of the same week share one key', () => {
        expect(GM.eventScoringKey('Shadowfront', 'SF1-20260802', '2026-07-27'))
            .toBe('Shadowfront|2026-07-27');
        expect(GM.eventScoringKey('Shadowfront', 'SF2-20260805', '2026-08-03'))
            .toBe('Shadowfront|2026-08-03');
    });

    it('SvS and GvG are keyed by week', () => {
        expect(GM.eventScoringKey('SvS', 'SVS-2026-W32', '2026-08-03')).toBe('SvS|2026-08-03');
        expect(GM.eventScoringKey('GvG', 'GVG-2026-W32', '2026-08-03')).toBe('GvG|2026-08-03');
    });

    it('each DTR session counts separately', () => {
        expect(GM.eventScoringKey('Defend Trade Route', 'DTR-20260804', '2026-08-03')).toBe('DTR|DTR-20260804');
        expect(GM.eventScoringKey('Defend Trade Route', 'DTR-20260812', '2026-08-10')).toBe('DTR|DTR-20260812');
    });
});
