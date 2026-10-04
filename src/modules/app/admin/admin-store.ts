/**
 * src/modules/app/admin/admin-store.ts
 *
 * Sous-lot 6.5 (Strangler) — in-memory admin state ported from app.js:
 * the `accounts` list and the `pendingPasswords` cache (kept in memory, never
 * in the DOM/localStorage). Shared by the accounts controller/renderer and the
 * guild-requests controller without duplicating module-level state.
 */

import { getAppState } from '../../../core/state/app-state';

export interface AccountRow {
  id: string;
  role?: string;
  guild?: string | null;
  status?: string;
  uid?: string | null;
  created_at?: string;
  server_number?: string | number | null;
  [key: string]: any;
}

let accounts: AccountRow[] = [];
const pendingPasswords: Record<string, string> = {};

export function getAccounts(): AccountRow[] {
  return accounts;
}

export function setAccounts(list: AccountRow[]): void {
  accounts = Array.isArray(list) ? list : [];
}

export function filterAccountsOut(id: string): void {
  accounts = accounts.filter((a) => a.id !== id);
}

export function unshiftAccount(account: AccountRow): void {
  accounts.unshift(account);
}

export function findAccount(id: string): AccountRow | undefined {
  const needle = String(id || '').toLowerCase();
  return accounts.find((a) => String(a.id || '').toLowerCase() === needle);
}

export function updateAccountRole(id: string, role: string, serverNumber?: string | number | null): void {
  const acc = findAccount(id);
  if (acc) {
    acc.role = role;
    if (serverNumber) acc.server_number = serverNumber;
  }
}

export function updateAccountGuild(id: string, guild: string | null): void {
  const acc = findAccount(id);
  if (acc) acc.guild = guild;
}

export function setPendingPassword(id: string, password: string): void {
  pendingPasswords[id] = password;
}

export function getPendingPassword(id: string): string | undefined {
  return pendingPasswords[id];
}

/** Server number resolution used by grouped renderers. */
export function getServerNumberForGuild(guildId: string): string {
  if (!guildId) return '';
  const guildsData = getAppState().guildsData;
  const entry = guildsData ? guildsData[guildId] : undefined;
  if (entry && entry.server_number) {
    return String(entry.server_number);
  }
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('gm_server_number_' + guildId) : null;
    if (ls) return String(ls);
  } catch (_) {
    /* ignore */
  }
  return '';
}

/** Test / re-auth isolation. */
export function clearAdminStore(): void {
  accounts = [];
  for (const k of Object.keys(pendingPasswords)) delete pendingPasswords[k];
}
