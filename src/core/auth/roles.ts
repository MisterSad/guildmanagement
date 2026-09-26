/**
 * src/core/auth/roles.ts
 *
 * Account roles model: super_admin, server_admin, guild_admin, member.
 */

import { escapeLike } from '../utils/text';
import { AccountRole } from '../../types/database';
import { getClient, sessionInfo, addSessionVerifiedListener, SessionInfo } from '../api/supabase';
import { APP_VERSION } from '../config/constants';
import { getAppState, patchAppState } from '../state/app-state';

let verifiedRole: AccountRole | null = null;
let verifiedAccountId: string | null = null;

export function setVerifiedRole(role: AccountRole | null, accountId?: string | null): void {
  verifiedRole = role;
  verifiedAccountId = accountId ?? null;
}

export function getVerifiedRole(): AccountRole | null {
  return verifiedRole;
}

export function getVerifiedAccountId(): string | null {
  return verifiedAccountId;
}

// Automatically sync verifiedRole with session verification events
addSessionVerifiedListener((info: SessionInfo | null) => {
  if (info) {
    setVerifiedRole(normalizeRole(info.role), info.accountId);
  } else {
    setVerifiedRole(null, null);
  }
});

export function normalizeRole(roleRaw: string | null | undefined): AccountRole {
  if (!roleRaw) return 'member';
  const s = String(roleRaw).toLowerCase().trim();
  if (s === 'super_admin') return 'super_admin';
  if (s === 'server_admin') return 'server_admin';
  if (s === 'guild_admin') return 'guild_admin';
  if (s === 'member') return 'member';
  return 'member';
}

export function roleFromStorage(): AccountRole {
  // Verified role from Supabase JWT/session takes absolute precedence over localStorage
  // to prevent client-side privilege escalation via DevTools/localStorage manipulation.
  if (verifiedRole !== null) {
    return verifiedRole;
  }
  try {
    const role = normalizeRole(localStorage.getItem('gm_role'));
    const serverRestriction = localStorage.getItem('gm_server_restriction');
    const guildRestriction = localStorage.getItem('gm_guild_restriction');
    if (role === 'member') {
      if (serverRestriction) return 'server_admin';
      if (guildRestriction) return 'guild_admin';
      if (typeof window !== 'undefined' && (window as any).currentGuildRestriction) return 'guild_admin';
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

function winAny(): any {
  return (typeof window !== 'undefined' ? window : {}) as any;
}

function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * Active guild id: restriction → current → localStorage, or `null`.
 *
 * FINDING H2. This used to end in `|| 'ALPHA'`, which made a failure to resolve
 * the tenant indistinguishable from "the tenant is ALPHA" -- a real, populated
 * guild. RLS contained the damage for a `guild_admin` (they simply read an empty
 * set), but a `super_admin` or an in-scope `server_admin` has rights over ALPHA,
 * so an unresolved guild meant reading, and potentially WRITING, another
 * tenant's data with no error anywhere. ADR-003 forbids exactly this
 * ("no specific tenant branch in frontend or backend logic").
 *
 * Returning `null` makes the failure explicit and forces callers to decide.
 * `canWriteGuild()` refuses it, which is what blocks every tenant write through
 * `db-guard`; views render an unresolved state instead of querying.
 */
export function getActiveGuild(): string | null {
  // Reads the typed store rather than the raw globals. The store still mirrors
  // onto `window` (and re-reads it), so behaviour is unchanged -- what changes
  // is that `core/` no longer reaches into `window.*` for application state,
  // and there is one reader of this chain instead of four.
  const st = getAppState();
  const store = ls();
  const resolved =
    st.currentGuildRestriction || st.currentGuild || (store ? store.getItem('gm_current_guild') : null);
  const trimmed = typeof resolved === 'string' ? resolved.trim() : '';
  return trimmed !== '' ? trimmed : null;
}

/** Logged-in pseudo (gm_user → gm_pseudo). */
export function getCurrentPseudo(): string | null {
  const store = ls();
  if (!store) return null;
  return store.getItem('gm_user') || store.getItem('gm_pseudo') || null;
}

/** Canonical account id (verifiedAccountId → window.GM.currentAccountId → gm_user). */
export function currentAccountId(): string | null {
  if (verifiedAccountId !== null) {
    return verifiedAccountId;
  }
  const w = winAny();
  const fromGm = w.GM && w.GM.currentAccountId;
  const store = ls();
  return fromGm || (store ? store.getItem('gm_user') : null) || null;
}

/** Role-based write access, mirroring gm-utils.js#canWriteGuild. */
export function canWriteGuild(guildId?: string | null): boolean {
  const activeG = guildId || getActiveGuild();
  // H2: an unresolved tenant blocks every write, including a super_admin's.
  // Without this the `super_admin` branch below returns true for a null guild,
  // and db-guard would then stamp `guild: null` onto the row or filter on it --
  // worse than refusing, and silent. This mirrors the doctrine the guild_admin
  // branch has always carried: writing to the wrong tenant is worse than
  // blocking.
  if (!activeG) return false;
  const role = roleFromStorage();
  const w = winAny();
  const store = ls();

  if (role === 'super_admin') return true;

  if (role === 'server_admin') {
    const serverRestriction = store ? store.getItem('gm_server_restriction') : null;
    if (!serverRestriction) return false;
    const targetData = getAppState().guildsData[activeG];
    if (!targetData || String(targetData.server_number) !== String(serverRestriction)) return false;
    return true;
  }

  if (role === 'guild_admin') {
    const restricted = getAppState().currentGuildRestriction;
    // Never fall back to a default guild: writing to the wrong tenant is worse
    // than blocking. Missing restriction ⇒ block (UI shows read-only).
    if (!restricted) return false;
    return activeG === restricted;
  }

  return false;
}

/**
 * Re-fetches the caller's guild restriction from accounts when missing
 * (defensive: login normally sets it). Returns the guild or null.
 */
export async function ensureGuildRestriction(): Promise<string | null> {
  const role = roleFromStorage();
  const w = winAny();
  if (role === 'super_admin') return null;
  if (role !== 'guild_admin') return null;
  if (getAppState().currentGuildRestriction) return getAppState().currentGuildRestriction;

  const c = getClient();
  if (!c) return null;
  try {
    const info = await sessionInfo();
    if (!info || !info.accountId) return null;
    const res = await c.from('accounts').select('guild').ilike('id', escapeLike(info.accountId)).maybeSingle();
    if (res && (res as any).data && (res as any).data.guild) {
      const guild = (res as any).data.guild;
      // Through the store, which mirrors onto `window` itself. Writing the
      // globals directly left getAppState() stale until its next re-hydration.
      patchAppState({ currentGuildRestriction: guild, currentGuild: guild });
      const store = ls();
      try {
        if (store) {
          store.setItem('gm_current_guild', guild);
          store.setItem('gm_guild_restriction', guild);
        }
      } catch (_) { /* storage unavailable */ }
      return guild;
    }
  } catch (_) { /* best-effort */ }
  return null;
}

export interface ClientEnvironment {
  appVersion: string;
  os: string;
  browser: string;
}

/** UA-based OS/browser detection (port of gm-utils.js#detectClientEnvironment). */
export function detectClientEnvironment(ua?: string): ClientEnvironment {
  const userAgent = (typeof ua === 'string' && ua)
    ? ua
    : (typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '');
  let os = 'Unknown OS';
  if (/iPhone|iPad|iPod/i.test(userAgent)) os = 'iOS';
  else if (/Macintosh|Mac\s+OS\s+X/i.test(userAgent)) os = 'macOS';
  else if (/Android/i.test(userAgent)) {
    const m = userAgent.match(/Android\s+([\d\.]+)/i);
    os = 'Android' + (m ? ' ' + m[1] : '');
  } else if (/Windows/i.test(userAgent)) {
    if (/Windows NT 10.0/i.test(userAgent)) os = 'Windows 10/11';
    else if (/Windows NT 6.3/i.test(userAgent)) os = 'Windows 8.1';
    else if (/Windows NT 6.1/i.test(userAgent)) os = 'Windows 7';
    else os = 'Windows';
  } else if (/Linux/i.test(userAgent)) os = 'Linux';

  let browser = 'Unknown Browser';
  if (/Edg\/([\d\.]+)/i.test(userAgent)) {
    const m = userAgent.match(/Edg\/([\d\.]+)/i);
    browser = 'Edge' + (m ? ' ' + m[1].split('.')[0] : '');
  } else if (/Chrome\/([\d\.]+)/i.test(userAgent) && !/Chromium|OPR/i.test(userAgent)) {
    const m = userAgent.match(/Chrome\/([\d\.]+)/i);
    browser = 'Chrome' + (m ? ' ' + m[1].split('.')[0] : '');
  } else if (/Safari\/([\d\.]+)/i.test(userAgent) && !/Chrome|Chromium|Android/i.test(userAgent)) {
    const m = userAgent.match(/Version\/([\d\.]+)/i);
    browser = 'Safari' + (m ? ' ' + m[1].split('.')[0] : '');
  } else if (/Firefox\/([\d\.]+)/i.test(userAgent)) {
    const m = userAgent.match(/Firefox\/([\d\.]+)/i);
    browser = 'Firefox' + (m ? ' ' + m[1].split('.')[0] : '');
  } else if (/OPR\/([\d\.]+)/i.test(userAgent)) {
    const m = userAgent.match(/OPR\/([\d\.]+)/i);
    browser = 'Opera' + (m ? ' ' + m[1].split('.')[0] : '');
  }

  return { appVersion: APP_VERSION, os: os.trim(), browser: browser.trim() };
}
