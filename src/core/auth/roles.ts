/**
 * src/core/auth/roles.ts
 *
 * Account roles model: super_admin, server_admin, guild_admin, member.
 */

import { AccountRole } from '../../types/database';

export function normalizeRole(roleRaw: string | null | undefined): AccountRole {
  if (!roleRaw) return 'member';
  if (roleRaw === 'R5' || roleRaw === 'admin' || roleRaw === 'super_admin') return 'super_admin';
  if (roleRaw === 'server_admin') return 'server_admin';
  if (roleRaw === 'R4' || roleRaw === 'guild_admin') return 'guild_admin';
  return 'member';
}

export function roleFromStorage(): AccountRole {
  try {
    const role = normalizeRole(localStorage.getItem('gm_role'));
    const serverRestriction = localStorage.getItem('gm_server_restriction');
    const guildRestriction = localStorage.getItem('gm_guild_restriction');
    if (role === 'member') {
      if (serverRestriction) return 'server_admin';
      if (guildRestriction) return 'guild_admin';
    }
    return role;
  } catch (e) {
    return 'member';
  }
}

export function isSuperAdmin(): boolean {
  return roleFromStorage() === 'super_admin';
}

export function isServerAdmin(): boolean {
  const role = roleFromStorage();
  return role === 'server_admin' || role === 'super_admin';
}

export function isGuildAdmin(): boolean {
  const role = roleFromStorage();
  return role === 'guild_admin' || role === 'server_admin' || role === 'super_admin';
}

export interface RoleInfo {
  role: AccountRole;
  isSuperAdmin: boolean;
  isServerAdmin: boolean;
  isGuildAdmin: boolean;
  isAdmin: boolean;
  guild: string | null;
  serverNumber: string | null;
}

export function getRoleInfoFromStorage(): RoleInfo {
  const role = roleFromStorage();
  const guild = typeof localStorage !== 'undefined' ? localStorage.getItem('gm_guild_restriction') : null;
  const serverNumber = typeof localStorage !== 'undefined' ? localStorage.getItem('gm_server_restriction') : null;
  return {
    role,
    isSuperAdmin: role === 'super_admin',
    isServerAdmin: role === 'server_admin' || role === 'super_admin',
    isGuildAdmin: role === 'guild_admin' || role === 'server_admin' || role === 'super_admin',
    isAdmin: role === 'super_admin' || role === 'server_admin' || role === 'guild_admin',
    guild,
    serverNumber
  };
}
