import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDbClient, resetSupabaseClient, sessionInfo } from '../src/core/api/supabase';
import { patchAppState } from '../src/core/state/app-state';
import { normalizeRole, roleFromStorage, canWriteGuild } from '../src/core/auth/roles';
import { getRoleInfo } from '../src/core/scoring/combat';

const GM = { normalizeRole, roleFromStorage, canWriteGuild, sessionInfo, getRoleInfo };

function makeJwt(appRole, accountId) {
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'none' })}.${enc({ app_metadata: { app_role: appRole, account_id: accountId } })}.sig`;
}

function mockSession(token) {
  setDbClient({
    auth: {
      getSession: async () => ({ data: { session: token ? { access_token: token } : null }, error: null }),
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  patchAppState({ currentGuildRestriction: null, guildsData: {}, currentGuild: 'ALPHA' });
});

afterEach(() => {
  resetSupabaseClient();
});

describe('normalizeRole', () => {
  it('strictly normalizes to canonical roles (H1 remediation: legacy ranks cannot elevate)', () => {
    expect(GM.normalizeRole('R5')).toBe('member');
    expect(GM.normalizeRole('admin')).toBe('member');
    expect(GM.normalizeRole('server_admin')).toBe('server_admin');
    expect(GM.normalizeRole('R4')).toBe('member');
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
    localStorage.setItem('gm_role', 'server_admin');
    expect(GM.roleFromStorage()).toBe('server_admin');
    localStorage.setItem('gm_role', 'guild_admin');
    expect(GM.roleFromStorage()).toBe('guild_admin');
    localStorage.setItem('gm_role', 'member');
    expect(GM.roleFromStorage()).toBe('member');
  });
  it('strictly maps legacy values to member (no elevation)', () => {
    localStorage.setItem('gm_role', 'admin');
    expect(GM.roleFromStorage()).toBe('member');
    localStorage.setItem('gm_role', 'R5');
    expect(GM.roleFromStorage()).toBe('member');
    localStorage.setItem('gm_role', 'R4');
    expect(GM.roleFromStorage()).toBe('member');
  });
  it('upgrades legacy member-with-restriction to guild_admin or server_admin', () => {
    localStorage.setItem('gm_role', 'member');
    patchAppState({ currentGuildRestriction: 'OMEGA' });
    expect(GM.roleFromStorage()).toBe('guild_admin');
    patchAppState({ currentGuildRestriction: null });
    localStorage.setItem('gm_server_restriction', '101');
    expect(GM.roleFromStorage()).toBe('server_admin');
    localStorage.removeItem('gm_server_restriction');
    expect(GM.roleFromStorage()).toBe('member');
  });
});

describe('sessionInfo role normalization', () => {
  it('normalizes legacy JWT app_role claims to member without elevation', async () => {
    mockSession(makeJwt('super_admin', 'hawkeye'));
    let info = await GM.sessionInfo();
    expect(info.role).toBe('super_admin');
    expect(info.accountId).toBe('hawkeye');

    mockSession(makeJwt('server_admin', 'overlord'));
    info = await GM.sessionInfo();
    expect(info.role).toBe('server_admin');
    expect(info.accountId).toBe('overlord');

    mockSession(makeJwt('guild_admin', 'officer'));
    info = await GM.sessionInfo();
    expect(info.role).toBe('guild_admin');

    mockSession(makeJwt('R5', 'rogue'));
    info = await GM.sessionInfo();
    expect(info.role).toBe('member');

    mockSession(makeJwt('R4', 'officer_legacy'));
    info = await GM.sessionInfo();
    expect(info.role).toBe('member');
  });
  it('passes through semantic claims', async () => {
    mockSession(makeJwt('guild_admin', 'x'));
    const info = await GM.sessionInfo();
    expect(info.role).toBe('guild_admin');
  });
  it('returns null without session', async () => {
    mockSession(null);
    const info = await GM.sessionInfo();
    expect(info).toBe(null);
  });
  it('returns null when app_role is absent from app_metadata', async () => {
    // JWT without app_role in app_metadata
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({ app_metadata: { account_id: 'orphan' } }));
    mockSession(`${header}.${payload}.signature`);
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
    expect(info.isServerAdmin).toBe(true);
    expect(info.isGuildAdmin).toBe(true);
  });
  it('falls back to storage without a session', async () => {
    mockSession(null);
    localStorage.setItem('gm_role', 'guild_admin');
    patchAppState({ currentGuildRestriction: 'ALPHA' });
    const info = await GM.getRoleInfo();
    expect(info.role).toBe('guild_admin');
    expect(info.isGuildAdmin).toBe(true);
    expect(info.guild).toBe('ALPHA');
  });
  it('correctly populates server_admin info from storage', async () => {
    mockSession(null);
    localStorage.setItem('gm_role', 'server_admin');
    localStorage.setItem('gm_server_restriction', '101');
    const info = await GM.getRoleInfo();
    expect(info.role).toBe('server_admin');
    expect(info.isSuperAdmin).toBe(false);
    expect(info.isServerAdmin).toBe(true);
    expect(info.isGuildAdmin).toBe(true);
    expect(info.isAdmin).toBe(true);
    expect(info.serverNumber).toBe('101');
  });
});

describe('canWriteGuild (server-agnostic client rules)', () => {
  it('super admin can write to every guild', () => {
    localStorage.setItem('gm_role', 'super_admin');
    expect(GM.canWriteGuild('ALPHA')).toBe(true);
    expect(GM.canWriteGuild('OMEGA')).toBe(true);
  });
  it('server admin can write to any guild on their server', () => {
    localStorage.setItem('gm_role', 'server_admin');
    localStorage.setItem('gm_server_restriction', '101');
    patchAppState({
      guildsData: {
        ALPHA: { server_number: '101', type: 'Unlimited' },
        BABE: { server_number: '101', type: 'Unlimited' },
        OMEGA: { server_number: '202', type: 'Unlimited' },
      },
    });
    expect(GM.canWriteGuild('ALPHA')).toBe(true);
    expect(GM.canWriteGuild('BABE')).toBe(true);
    expect(GM.canWriteGuild('OMEGA')).toBe(false);
  });
  it('guild admin writes only to their restricted guild', () => {
    localStorage.setItem('gm_role', 'guild_admin');
    patchAppState({ currentGuildRestriction: 'OMEGA' });
    expect(GM.canWriteGuild('OMEGA')).toBe(true);
    expect(GM.canWriteGuild('ALPHA')).toBe(false);
  });
  it('guild admin can write to assigned guild (subscription expiry no longer blocks writes since v127.0)', () => {
    localStorage.setItem('gm_role', 'guild_admin');
    patchAppState({ currentGuildRestriction: 'OMEGA' });
    patchAppState({ guildsData: { OMEGA: { type: 'Premium', end: '2020-01-01T00:00:00Z' } } });
    expect(GM.canWriteGuild('OMEGA')).toBe(true);
    patchAppState({ guildsData: { OMEGA: { type: 'Unlimited' } } });
    expect(GM.canWriteGuild('OMEGA')).toBe(true);
  });
  it('super_admin storage value is honored', () => {
    localStorage.setItem('gm_role', 'super_admin');
    expect(GM.canWriteGuild('ALPHA')).toBe(true);
  });
});
