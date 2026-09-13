/**
 * src/core/api/supabase.ts
 *
 * Supabase client accessor & REST helper wrappers.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config/constants';
import { normalizeRole } from '../utils/text';
import { mapFetchError } from './fetch-errors';

let client: SupabaseClient | null = null;

export function getSupabaseConfig(): { url: string; key: string } {
  const url = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_SUPABASE_URL : undefined) || '';
  const key = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_SUPABASE_ANON_KEY : undefined) || '';
  return { url, key };
}

export function validateSupabaseEnv(): { url: string; anonKey: string } {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) {
    throw new Error(
      'Supabase initialization error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variable.'
    );
  }
  return { url, anonKey: key };
}

export function resetSupabaseClient(): void {
  client = null;
}

/**
 * Runtime client accessor (port of gm-utils.js#getClient): returns the live
 * window.GM.db (tests / hot-swap) and nothing else — never a cached client.
 */
export function getClient(): SupabaseClient | null {
  if (typeof window !== 'undefined' && (window as any).GM && (window as any).GM.db) {
    return (window as any).GM.db;
  }
  return null;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (client) return client;

  if (typeof window !== 'undefined' && (window as any).GM && (window as any).GM.db) {
    client = (window as any).GM.db;
    return client;
  }

  const { url, key } = getSupabaseConfig();

  if (!url || !key) {
    console.error(
      '[Supabase] Configuration error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables.'
    );
    return null;
  }

  try {
    if (typeof window !== 'undefined' && (window as any).supabase?.createClient) {
      client = (window as any).supabase.createClient(url, key);
      return client;
    }
    client = createClient(url, key);
    return client;
  } catch (e) {
    console.error('Supabase init error:', e);
    return null;
  }
}

// Must stay byte-for-byte equivalent to gm-utils.js's escapeHTML (legacy):
// window.GM.escapeHTML gets reassigned to this one on every page load
// (see main.ts), so any drift here is a silent, load-order-dependent
// regression for every legacy module reading window.GM.escapeHTML.
export function escapeHTML(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

export interface SessionInfo {
  role: string;
  accountId: string | null;
}

/**
 * Recovers the real body of an Edge Function invocation even when the platform
 * gateway rejected it with a non-2xx status (rate limit, auth, ...): supabase-js
 * otherwise discards that body. Mirrors gm-utils.js#parseFunctionsInvokeResult.
 */
export async function parseFunctionsInvokeResult(result: any): Promise<any> {
  if (result && result.data) return result.data;
  const ctx = result && result.error && result.error.context;
  if (ctx && typeof ctx.clone === 'function') {
    try {
      const body = await ctx.clone().json();
      if (body && typeof body === 'object') return body;
    } catch (e) { /* not JSON, or already consumed — fall through */ }
  }
  return { ok: false, error: (result && result.error && result.error.message) || 'request_failed' };
}

/** Returns the current Supabase session, refreshing it if it expires within 60s. */
export async function ensureAuthSession(): Promise<any> {
  const c = getClient();
  if (!c) return null;
  try {
    let s = await c.auth.getSession();
    const session = (s && s.data) ? s.data.session : null;
    if (session) {
      const exp = (session as any).expires_at;
      const now = Math.floor(Date.now() / 1000);
      if (exp && (exp - now < 60)) {
        const ref = await c.auth.refreshSession();
        if (ref && ref.data && ref.data.session) {
          resetSessionInvalidationFlag();
          return ref.data.session;
        }
        if (ref && ref.error && isUnauthorizedError(ref.error)) {
          handleSessionInvalidation();
          return null;
        }
      }
      resetSessionInvalidationFlag();
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    s = await c.auth.getSession();
    return (s && s.data) ? s.data.session : null;
  } catch (e) {
    console.warn('ensureAuthSession error', e);
    return null;
  }
}

/** supabase-js default storage key: `sb-<projectRef>-auth-token`. */
export function storageKeyForProject(): string | null {
  const m = String(SUPABASE_URL).match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? 'sb-' + m[1] + '-auth-token' : null;
}

/* ---------------------------------------------------------------------------
 * Session invalidation (P3-02): centralized handling of real 401 / jwt-expired
 * errors so every tab load converges on a single "reconnect" path instead of
 * per-view generic toasts or silent empty lists.
 * ------------------------------------------------------------------------- */

let sessionInvalidFlag = false;

/** True when the error is a definite auth-session invalidation (401 / JWT expired / invalid refresh grant). */
export function isUnauthorizedError(err: any): boolean {
  return mapFetchError(err).kind === 'unauthorized';
}

/** Purges the persisted GoTrue session from storage (sb-* / supabase.* keys). */
export function purgeInvalidSessionStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = storageKeyForProject();
    if (key) localStorage.removeItem(key);
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('sb-') || k.startsWith('supabase.'))) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

/** Re-arms the invalidation guard after a successful session refresh. */
export function resetSessionInvalidationFlag(): void {
  sessionInvalidFlag = false;
}

/**
 * Runs the single invalidation flow: purge the persisted session once (guarded,
 * so a cascade of parallel 401s cannot spam), then dispatch `gm:session-expired`
 * which the bootstrap listens for to close the session and show the login panel.
 */
export function handleSessionInvalidation(): void {
  if (sessionInvalidFlag) return;
  sessionInvalidFlag = true;
  purgeInvalidSessionStorage();
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new Event('gm:session-expired'));
    } catch { /* noop */ }
  }
}

export interface PortalSessionInfo {
  role: string;
  accountId: string | null;
}

/**
 * Fallback for player-portal sessions: read the refresh token straight from the
 * supabase-js storage entry, exchange it against GoTrue, re-inject the session.
 */
export async function forceRefreshPortalSession(): Promise<PortalSessionInfo | null> {
  const c = getClient();
  if (!c) return null;
  const key = storageKeyForProject();
  if (!key) return null;

  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch (_) { return null; }
  if (!raw) return null;

  let stored: any = null;
  try {
    stored = typeof raw === 'string' && raw.charAt(0) === '{' ? JSON.parse(raw) : null;
    if (!stored && raw.charAt(0) !== '{') stored = JSON.parse(decodeURIComponent(raw));
  } catch (_) { return null; }

  const refreshToken = stored && (stored.refresh_token || (stored.currentSession && stored.currentSession.refresh_token));
  if (!refreshToken) return null;

  try {
    const resp = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const data = await resp.json();
    if (!data || !data.access_token) {
      // Invalidated/Ghost refresh grant: route through the shared invalidation flow.
      if (data && isUnauthorizedError(data)) handleSessionInvalidation();
      return null;
    }
    const s = await c.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
    if (s.error) return null;
    const p = data.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = p + '='.repeat((4 - p.length % 4) % 4);
    const jsonStr = atob(padded).split('').map((ch: string) => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join('');
    const claims = JSON.parse(decodeURIComponent(jsonStr));
    const am = claims.app_metadata || {};
    return { role: normalizeRole(am.app_role || 'member'), accountId: am.account_id || null };
  } catch (_) {
    return null;
  }
}

/** Decodes the current session JWT into { role, accountId } (or null). */
export async function sessionInfo(): Promise<SessionInfo | null> {
  const c = getClient();
  if (!c) return null;
  let res: any;
  try { res = await c.auth.getSession(); } catch (_) { return null; }
  const session = res && res.data && res.data.session;
  if (!session || !session.access_token) return null;
  try {
    const p = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = p + '='.repeat((4 - p.length % 4) % 4);
    const jsonStr = atob(padded).split('').map((ch: string) => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join('');
    const claims = JSON.parse(decodeURIComponent(jsonStr));
    const am = claims.app_metadata || {};
    if (!am.app_role) return null;
    return { role: normalizeRole(am.app_role), accountId: am.account_id || null };
  } catch (e) {
    return null;
  }
}
