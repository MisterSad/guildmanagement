/**
 * src/core/auth/roles.ts
 *
 * Account roles model: super_admin, guild_admin, member.
 */

import { AccountRole } from '../../types/database';

export function normalizeRole(roleRaw: string | null | undefined): AccountRole {
  if (!roleRaw) return 'member';
  if (roleRaw === 'R5' || roleRaw === 'admin' || roleRaw === 'super_admin') return 'super_admin';
  if (roleRaw === 'R4' || roleRaw === 'guild_admin') return 'guild_admin';
  return 'member';
}

export function roleFromStorage(): AccountRole {
  try {
    const role = normalizeRole(localStorage.getItem('gm_role'));
    const restriction = localStorage.getItem('gm_guild_restriction');
    if (role === 'member' && restriction) return 'guild_admin';
    return role;
  } catch (e) {
    return 'member';
  }
}

export function isSuperAdmin(): boolean {
  return roleFromStorage() === 'super_admin';
}

export function isGuildAdmin(): boolean {
  const role = roleFromStorage();
  return role === 'guild_admin' || role === 'super_admin';
}

export interface RoleInfo {
  role: AccountRole;
  isSuperAdmin: boolean;
  isGuildAdmin: boolean;
  isAdmin: boolean;
  guild: string | null;
}

export function getRoleInfoFromStorage(): RoleInfo {
  const role = roleFromStorage();
  const guild = typeof localStorage !== 'undefined' ? localStorage.getItem('gm_guild_restriction') : null;
  return {
    role,
    isSuperAdmin: role === 'super_admin',
    isGuildAdmin: role === 'guild_admin',
    isAdmin: role === 'super_admin' || role === 'guild_admin',
    guild
  };
}
