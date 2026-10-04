import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setVerifiedRole,
  getVerifiedRole,
  getVerifiedAccountId,
  roleFromStorage,
  isSuperAdmin,
  isServerAdmin,
  isGuildAdmin,
  currentAccountId,
} from '../src/core/auth/roles';
import { notifySessionVerified, sessionInfo, setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { patchAppState } from '../src/core/state/app-state';

function makeJwt(appRole, accountId) {
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'none' })}.${enc({ app_metadata: { app_role: appRole, account_id: accountId } })}.sig`;
}

describe('JWT & Session Role Verification (TICKET-09 / SEC-05)', () => {
  beforeEach(() => {
    localStorage.clear();
    setVerifiedRole(null, null);
    patchAppState({ currentGuildRestriction: null, guildsData: {}, currentGuild: 'ALPHA' });
  });

  afterEach(() => {
    setVerifiedRole(null, null);
    resetSupabaseClient();
  });

  describe('Privilege Escalation Defense (LocalStorage Tampering)', () => {
    it('prevents localStorage tampering when verifiedRole is member', () => {
      // User is verified as member via Supabase session/JWT
      setVerifiedRole('member', 'player_123');
      expect(getVerifiedRole()).toBe('member');
      expect(getVerifiedAccountId()).toBe('player_123');

      // Malicious user tampers with localStorage in DevTools
      localStorage.setItem('gm_role', 'super_admin');
      localStorage.setItem('gm_user', 'admin_target');

      // roleFromStorage and currentAccountId MUST ignore localStorage
      expect(roleFromStorage()).toBe('member');
      expect(isSuperAdmin()).toBe(false);
      expect(isServerAdmin()).toBe(false);
      expect(isGuildAdmin()).toBe(false);
      expect(currentAccountId()).toBe('player_123');
    });

    it('prevents localStorage tampering when verifiedRole is guild_admin', () => {
      setVerifiedRole('guild_admin', 'officer_456');

      // Malicious user attempts escalation to super_admin
      localStorage.setItem('gm_role', 'super_admin');

      expect(roleFromStorage()).toBe('guild_admin');
      expect(isSuperAdmin()).toBe(false);
      expect(isServerAdmin()).toBe(false);
      expect(isGuildAdmin()).toBe(true);
      expect(currentAccountId()).toBe('officer_456');
    });

    it('falls back to localStorage when verifiedRole is null (no active verified session)', () => {
      setVerifiedRole(null, null);
      localStorage.setItem('gm_role', 'guild_admin');
      localStorage.setItem('gm_user', 'legacy_user');

      expect(roleFromStorage()).toBe('guild_admin');
      expect(isGuildAdmin()).toBe(true);
      expect(currentAccountId()).toBe('legacy_user');
    });
  });

  describe('Session Verified Event Notification', () => {
    it('automatically updates verifiedRole when notifySessionVerified is fired', () => {
      notifySessionVerified({ role: 'server_admin', accountId: 'srv_mod' });

      expect(getVerifiedRole()).toBe('server_admin');
      expect(getVerifiedAccountId()).toBe('srv_mod');
      expect(roleFromStorage()).toBe('server_admin');
      expect(isServerAdmin()).toBe(true);
      expect(isSuperAdmin()).toBe(false);
    });

    it('clears verifiedRole when notifySessionVerified(null) is called', () => {
      setVerifiedRole('super_admin', 'root');
      notifySessionVerified(null);

      expect(getVerifiedRole()).toBeNull();
      expect(getVerifiedAccountId()).toBeNull();
      // Falls back to localStorage or default member
      expect(roleFromStorage()).toBe('member');
    });

    it('integrates with sessionInfo() to verify role from Supabase JWT', async () => {
      const token = makeJwt('guild_admin', 'verified_officer');
      setDbClient({
        auth: {
          getSession: async () => ({
            data: { session: { access_token: token } },
            error: null,
          }),
        },
      });

      const info = await sessionInfo();
      expect(info).toEqual({ role: 'guild_admin', accountId: 'verified_officer' });

      // Check that notifySessionVerified was triggered by sessionInfo()
      expect(getVerifiedRole()).toBe('guild_admin');
      expect(getVerifiedAccountId()).toBe('verified_officer');
      expect(roleFromStorage()).toBe('guild_admin');
      expect(isGuildAdmin()).toBe(true);
    });
  });

  describe('Verified-role API surface', () => {
    // The window bridge that used to re-export these is gone (M4c): the
    // verified-role API is reachable only as module exports.
    it('exposes setVerifiedRole, getVerifiedRole, getVerifiedAccountId as module exports, not on window', () => {
      expect(typeof setVerifiedRole).toBe('function');
      expect(typeof getVerifiedRole).toBe('function');
      expect(typeof getVerifiedAccountId).toBe('function');
      expect('GM' in window).toBe(false);

      setVerifiedRole('super_admin', 'super_user');
      expect(getVerifiedRole()).toBe('super_admin');
      expect(getVerifiedAccountId()).toBe('super_user');
      expect(roleFromStorage()).toBe('super_admin');
    });
  });
});
