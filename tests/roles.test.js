import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';

const GM = window.GM;

function makeJwt(appRole, accountId) {
    const enc = (obj) =>
        btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${enc({ alg: 'none' })}.${enc({ app_metadata: { app_role: appRole, account_id: accountId } })}.sig`;
}

function mockSession(token) {
    GM.db = {
        auth: {
            getSession: async () => ({ data: { session: token ? { access_token: token } : null }, error: null })
        }
    };
}

beforeEach(() => {
    localStorage.clear();
    window.currentGuildRestriction = null;
    window.guildsData = null;
    window.currentGuild = 'ALPHA';
});

afterEach(() => {
    delete GM.db;
});

describe('normalizeRole', () => {
    it('maps legacy values to semantic roles', () => {
        expect(GM.normalizeRole('R5')).toBe('super_admin');
        expect(GM.normalizeRole('admin')).toBe('super_admin');
        expect(GM.normalizeRole('R4')).toBe('guild_admin');
        expect(GM.normalizeRole('super_admin')).toBe('super_admin');
        expect(GM.normalizeRole('guild_admin')).toBe('guild_admin');
        expect(GM.normalizeRole('member')).toBe('member');
        expect(GM.normalizeRole(null)).toBe('member');
        expect(GM.normalizeRole(undefined)).toBe('member');
        expect(GM.normalizeRole('weird')).toBe('member');
    });
});

describe('roleFromStorage', () => {
    it('reads normalized values directly', () => {
        localStorage.setItem('gm_role', 'super_admin');
        expect(GM.roleFromStorage()).toBe('super_admin');
        localStorage.setItem('gm_role', 'guild_admin');
        expect(GM.roleFromStorage()).toBe('guild_admin');
        localStorage.setItem('gm_role', 'member');
        expect(GM.roleFromStorage()).toBe('member');
    });
    it('maps legacy storage values', () => {
        localStorage.setItem('gm_role', 'admin');
        expect(GM.roleFromStorage()).toBe('super_admin');
        localStorage.setItem('gm_role', 'R5');
        expect(GM.roleFromStorage()).toBe('super_admin');
        localStorage.setItem('gm_role', 'R4');
        expect(GM.roleFromStorage()).toBe('guild_admin');
    });
    it('upgrades legacy member-with-restriction to guild_admin', () => {
        localStorage.setItem('gm_role', 'member');
        window.currentGuildRestriction = 'OMEGA';
        expect(GM.roleFromStorage()).toBe('guild_admin');
        window.currentGuildRestriction = null;
        expect(GM.roleFromStorage()).toBe('member');
    });
});

describe('sessionInfo role normalization', () => {
    it('normalizes legacy JWT app_role claims', async () => {
        mockSession(makeJwt('R5', 'hawkeye'));
        let info = await GM.sessionInfo();
        expect(info.role).toBe('super_admin');
        expect(info.accountId).toBe('hawkeye');

        mockSession(makeJwt('R4', 'officer'));
        info = await GM.sessionInfo();
        expect(info.role).toBe('guild_admin');
    });
    it('passes through semantic claims', async () => {
        mockSession(makeJwt('guild_admin', 'x'));
        const info = await GM.sessionInfo();
        expect(info.role).toBe('guild_admin');
    });
    it('returns guild_admin fallback without session', async () => {
        mockSession(null);
        const info = await GM.sessionInfo();
        expect(info).toBe(null);
    });
});

describe('getRoleInfo', () => {
    it('prioritizes JWT role over storage', async () => {
        localStorage.setItem('gm_role', 'guild_admin');
        mockSession(makeJwt('super_admin', 'hawkeye'));
        const info = await GM.getRoleInfo();
        expect(info.role).toBe('super_admin');
        expect(info.isSuperAdmin).toBe(true);
        expect(info.isAdmin).toBe(true);
        expect(info.isGuildAdmin).toBe(false);
    });
    it('falls back to storage without a session', async () => {
        mockSession(null);
        localStorage.setItem('gm_role', 'guild_admin');
        window.currentGuildRestriction = 'ALPHA';
        const info = await GM.getRoleInfo();
        expect(info.role).toBe('guild_admin');
        expect(info.isGuildAdmin).toBe(true);
        expect(info.guild).toBe('ALPHA');
    });
});

describe('canWriteGuild (server-agnostic client rules)', () => {
    it('super admin can write to every guild', () => {
        localStorage.setItem('gm_role', 'super_admin');
        expect(GM.canWriteGuild('ALPHA')).toBe(true);
        expect(GM.canWriteGuild('OMEGA')).toBe(true);
    });
    it('guild admin writes only to their restricted guild', () => {
        localStorage.setItem('gm_role', 'guild_admin');
        window.currentGuildRestriction = 'OMEGA';
        expect(GM.canWriteGuild('OMEGA')).toBe(true);
        expect(GM.canWriteGuild('ALPHA')).toBe(false);
    });
    it('guild admin is blocked when the subscription expired', () => {
        localStorage.setItem('gm_role', 'guild_admin');
        window.currentGuildRestriction = 'OMEGA';
        window.guildsData = { OMEGA: { type: 'Premium', end: '2020-01-01T00:00:00Z' } };
        expect(GM.canWriteGuild('OMEGA')).toBe(false);
        window.guildsData = { OMEGA: { type: 'Unlimited' } };
        expect(GM.canWriteGuild('OMEGA')).toBe(true);
    });
    it('legacy admin storage value is honored', () => {
        localStorage.setItem('gm_role', 'admin');
        expect(GM.canWriteGuild('ALPHA')).toBe(true);
    });
});
