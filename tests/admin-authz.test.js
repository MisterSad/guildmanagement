import { describe, it, expect } from 'vitest';
import {
  canManageAccount,
  maxAssignableRole,
  isGuildInScope
} from '../supabase/functions/_shared/admin-authz';

describe('admin-authz pure authorization matrix', () => {
  describe('maxAssignableRole', () => {
    it('returns super_admin for super_admin', () => {
      expect(maxAssignableRole('super_admin')).toBe('super_admin');
    });

    it('returns guild_admin for server_admin', () => {
      expect(maxAssignableRole('server_admin')).toBe('guild_admin');
    });

    it('returns guild_admin for guild_admin', () => {
      expect(maxAssignableRole('guild_admin')).toBe('guild_admin');
    });

    it('returns null for member or null', () => {
      expect(maxAssignableRole('member')).toBeNull();
      expect(maxAssignableRole(null)).toBeNull();
    });
  });

  describe('isGuildInScope', () => {
    const superAdmin = { role: 'super_admin', guild: null, serverNumber: null };
    const serverAdminS100 = { role: 'server_admin', guild: 'ALPHA', serverNumber: '100' };
    const guildAdminAlpha = { role: 'guild_admin', guild: 'ALPHA', serverNumber: '100' };
    const memberAlpha = { role: 'member', guild: 'ALPHA', serverNumber: '100' };

    it('allows super_admin for any guild and server', () => {
      expect(isGuildInScope(superAdmin, 'ALPHA', '100')).toBe(true);
      expect(isGuildInScope(superAdmin, 'BETA', '200')).toBe(true);
      expect(isGuildInScope(superAdmin, null, null)).toBe(true);
    });

    it('allows server_admin only for guilds on the same server', () => {
      expect(isGuildInScope(serverAdminS100, 'ALPHA', '100')).toBe(true);
      expect(isGuildInScope(serverAdminS100, 'BETA', 100)).toBe(true);
      expect(isGuildInScope(serverAdminS100, 'GAMMA', '200')).toBe(false);
      expect(isGuildInScope(serverAdminS100, 'DELTA', null)).toBe(false);
    });

    it('allows guild_admin only for their own specific guild', () => {
      expect(isGuildInScope(guildAdminAlpha, 'ALPHA', '100')).toBe(true);
      expect(isGuildInScope(guildAdminAlpha, 'alpha', '100')).toBe(true);
      expect(isGuildInScope(guildAdminAlpha, 'BETA', '100')).toBe(false);
      expect(isGuildInScope(guildAdminAlpha, null, '100')).toBe(false);
    });

    it('denies member or unauthenticated callers', () => {
      expect(isGuildInScope(memberAlpha, 'ALPHA', '100')).toBe(false);
      expect(isGuildInScope({ role: null, guild: null, serverNumber: null }, 'ALPHA', '100')).toBe(false);
    });
  });

  describe('canManageAccount', () => {
    const superAdmin = { role: 'super_admin', guild: null, serverNumber: null };
    const serverAdminS100 = { role: 'server_admin', guild: 'ALPHA', serverNumber: '100' };
    const serverAdminS200 = { role: 'server_admin', guild: 'BETA', serverNumber: '200' };
    const guildAdminAlpha = { role: 'guild_admin', guild: 'ALPHA', serverNumber: '100' };
    const guildAdminBeta = { role: 'guild_admin', guild: 'BETA', serverNumber: '100' };
    const memberAlpha = { role: 'member', guild: 'ALPHA', serverNumber: '100' };
    const memberBeta = { role: 'member', guild: 'BETA', serverNumber: '100' };
    const targetSuperAdmin = { role: 'super_admin', guild: null, serverNumber: null };

    it('allows super_admin to manage any account', () => {
      expect(canManageAccount(superAdmin, targetSuperAdmin)).toBe(true);
      expect(canManageAccount(superAdmin, serverAdminS100)).toBe(true);
      expect(canManageAccount(superAdmin, guildAdminAlpha)).toBe(true);
      expect(canManageAccount(superAdmin, memberAlpha)).toBe(true);
    });

    it('prevents server_admin from managing super_admin', () => {
      expect(canManageAccount(serverAdminS100, targetSuperAdmin)).toBe(false);
    });

    it('allows server_admin to manage accounts within their server', () => {
      expect(canManageAccount(serverAdminS100, guildAdminAlpha)).toBe(true);
      expect(canManageAccount(serverAdminS100, guildAdminBeta)).toBe(true);
      expect(canManageAccount(serverAdminS100, memberAlpha)).toBe(true);
      expect(canManageAccount(serverAdminS100, memberBeta)).toBe(true);
    });

    it('prevents server_admin from managing accounts on other servers', () => {
      const guildAdminOther = { role: 'guild_admin', guild: 'GAMMA', serverNumber: '200' };
      const memberOther = { role: 'member', guild: 'GAMMA', serverNumber: '200' };
      expect(canManageAccount(serverAdminS100, guildAdminOther)).toBe(false);
      expect(canManageAccount(serverAdminS100, memberOther)).toBe(false);
    });

    it('prevents guild_admin from managing super_admin or server_admin', () => {
      expect(canManageAccount(guildAdminAlpha, targetSuperAdmin)).toBe(false);
      expect(canManageAccount(guildAdminAlpha, serverAdminS100)).toBe(false);
    });

    it('allows guild_admin to manage only accounts within their own guild', () => {
      const otherGuildAdminAlpha = { role: 'guild_admin', guild: 'ALPHA', serverNumber: '100' };
      expect(canManageAccount(guildAdminAlpha, otherGuildAdminAlpha)).toBe(true);
      expect(canManageAccount(guildAdminAlpha, memberAlpha)).toBe(true);
      expect(canManageAccount(guildAdminAlpha, memberBeta)).toBe(false);
      expect(canManageAccount(guildAdminAlpha, guildAdminBeta)).toBe(false);
    });

    it('denies member from managing any account', () => {
      expect(canManageAccount(memberAlpha, memberAlpha)).toBe(false);
      expect(canManageAccount(memberAlpha, guildAdminAlpha)).toBe(false);
      expect(canManageAccount({ role: null, guild: null, serverNumber: null }, memberAlpha)).toBe(false);
    });
  });
});
