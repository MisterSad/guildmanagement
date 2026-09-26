/**
 * src/core/auth/session.ts
 *
 * Auth/session orchestration ported from gm-utils.js: password login, logout,
 * player registration, guild-request submission, admin account actions, join
 * code generation, and the passkey/backup-code session wrappers (which delegate
 * to the WebAuthn bridge on window.GM.webauthn).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getClient, parseFunctionsInvokeResult } from '../api/supabase';
import { SUPABASE_URL } from '../config/constants';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : {}) as any;
}

const AUTH_REQUEST_TIMEOUT_MS = 20_000;

/** Rejects `promise` after `ms` unless it settles first (bounds network waits). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth_request_timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

/** Password login via the auth-login Edge Function, then setSession. */
export async function login(id: string, password: string): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await withTimeout(
      c.functions.invoke('auth-login', { body: { id: id, password: password } }),
      AUTH_REQUEST_TIMEOUT_MS
    );
  } catch (e: any) {
    return {
      ok: false,
      error: (e && e.message === 'auth_request_timeout') ? 'request_timeout' : 'request_failed'
    };
  }
  const data = await parseFunctionsInvokeResult(r);

  // A successful auth-login payload always carries `ok: true`. Older/stale
  // deployments used to return the minted GoTrue session WITHOUT the `ok` flag;
  // accept that shape too so a version mismatch cannot lock everyone out.
  if (data && !data.ok && data.access_token && data.refresh_token) {
    const legacy = await c.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
    if (legacy.error) return { ok: false, error: 'session_set_failed' };
    return { ok: true, role: data.role, id: data.id, hasPasskey: !!data.has_passkey };
  }

  if (!data || !data.ok) {
    // Gateway error bodies (404 "not found", 401 verify_jwt, 500 crash, ...)
    // have no `error` key — surface the real detail instead of the bare
    // "invalid" fallback that made the failure impossible to diagnose.
    const detail =
      (data && (data.error || data.msg || data.message || data.code)) ||
      (r && r.error && r.error.message) ||
      'request_failed';
    return { ok: false, error: String(detail) };
  }

  const s = await c.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
  if (s.error) return { ok: false, error: 'session_set_failed' };
  return { ok: true, role: data.role, id: data.id, hasPasskey: !!data.has_passkey };
}

/**
 * Applies a minted `{ ok, access_token, refresh_token, role, id }` payload.
 *
 * Every credential method that ends at `establishShadowSession` server-side --
 * passkey, backup code, Discord -- lands here, so there is one place where a
 * session is installed rather than one per method.
 */
export async function applySessionResponse(data: any, extraFields?: Record<string, unknown>): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'invalid' };
  const s = await c.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
  if (s.error) return { ok: false, error: 'session_set_failed' };
  const result: AuthResult = { ok: true, role: data.role, id: data.id };
  if (extraFields) {
    for (const k in extraFields) result[k] = extraFields[k];
  }
  return result;
}

/** Applies a { ok, access_token, refresh_token, ... } passkey response. */
export async function applyPasskeySessionData(data: any, extraFields?: Record<string, unknown>): Promise<AuthResult> {
  return applySessionResponse(data, { hasPasskey: true, ...(extraFields || {}) });
}

/** Passkey login (delegates the ceremony to window.GM.webauthn). */
export async function loginWithPasskey(id?: string): Promise<AuthResult> {
  const w = winAny();
  if (!w.GM || !w.GM.webauthn) return { ok: false, error: 'webauthn_unavailable' };
  const data = await w.GM.webauthn.authenticateWithPasskey(id);
  return applyPasskeySessionData(data);
}

/** Backup-code login (delegates to window.GM.webauthn.redeemBackupCode). */
export async function loginWithBackupCode(id: string, code: string): Promise<AuthResult> {
  const w = winAny();
  if (!w.GM || !w.GM.webauthn) return { ok: false, error: 'webauthn_unavailable' };
  const data = await w.GM.webauthn.redeemBackupCode(id, code);
  return applyPasskeySessionData(data, { backupCodesRemaining: data && data.backup_codes_remaining });
}

/** Starts the conditional/autofill passkey listener; resolves null if none. */
export async function startConditionalPasskeyLogin(): Promise<AuthResult | null> {
  const w = winAny();
  if (!w.GM || !w.GM.webauthn) return null;
  const data = await w.GM.webauthn.startConditionalAuth();
  if (!data) return null;
  return applyPasskeySessionData(data);
}

export function abortConditionalPasskeyLogin(): void {
  const w = winAny();
  if (w.GM && w.GM.webauthn && w.GM.webauthn.abortConditionalAuth) {
    w.GM.webauthn.abortConditionalAuth();
  }
}

/** Query parameter the auth-discord callback appends on success. */
export const DISCORD_TICKET_PARAM = 'gm_auth';
/** ...and on failure. */
export const DISCORD_ERROR_PARAM = 'gm_auth_error';

/**
 * Starts the Discord sign-in by navigating the whole page to auth-discord/start.
 *
 * A full-page redirect, not a popup: `vercel.json` sets
 * `Cross-Origin-Opener-Policy: same-origin`, which severs `window.opener`, so
 * the usual popup + postMessage handshake would never fire.
 *
 * The origin is passed so the Edge Function knows where to send the user back.
 * It is not trusted: the function validates it with `isAllowedOrigin()` and
 * silently falls back to APP_DEFAULT_ORIGIN, so a tampered value cannot turn
 * this into an open redirect.
 */
export function loginWithDiscord(): void {
  if (typeof window === 'undefined') return;
  const origin = window.location.origin;
  const url = SUPABASE_URL + '/functions/v1/auth-discord/start?origin=' + encodeURIComponent(origin);
  window.location.assign(url);
}

/**
 * Spends a one-time ticket for a real session.
 *
 * The ticket carries no token of its own -- it only attests that this browser
 * completed a Discord authorization -- so the session is minted server-side
 * here, on a single-use redemption.
 *
 * Resolves to `{ ok: true, state: 'unlinked' }` when the Discord account is
 * not attached to any account yet. That is not an error: phases D3 (claim) and
 * D4 (onboarding) hang off exactly this branch.
 */
export async function redeemDiscordTicket(ticket: string): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await withTimeout(
      c.functions.invoke('auth-discord', { body: { action: 'redeem', ticket: ticket } }),
      AUTH_REQUEST_TIMEOUT_MS
    );
  } catch (e: any) {
    return {
      ok: false,
      error: (e && e.message === 'auth_request_timeout') ? 'request_timeout' : 'request_failed'
    };
  }
  const data = await parseFunctionsInvokeResult(r);
  if (!data || !data.ok) {
    const detail =
      (data && (data.error || data.msg || data.message || data.code)) ||
      (r && r.error && r.error.message) ||
      'request_failed';
    return { ok: false, error: String(detail) };
  }
  if (data.state === 'unlinked') {
    // `ticket` is a CONTINUATION ticket for the same Discord identity: the one
    // that arrived in the URL has just been spent. It lets the caller present a
    // relink code without redoing the whole Discord round trip.
    return {
      ok: true,
      state: 'unlinked',
      ticket: data.ticket || null,
      discordUsername: data.discord_username || null
    };
  }
  return applySessionResponse(data, { state: 'session' });
}

/**
 * Attaches a Discord identity to an account using a single-use relink code.
 *
 * Takes the continuation ticket from an `unlinked` redemption, so the code
 * alone is never enough: the caller must also have just proved control of the
 * Discord account being attached. That is what stops a leaked code from being
 * redeemable by whoever finds it.
 */
export async function relinkWithDiscord(ticket: string, code: string): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await withTimeout(
      c.functions.invoke('auth-discord', { body: { action: 'relink', ticket: ticket, code: code } }),
      AUTH_REQUEST_TIMEOUT_MS
    );
  } catch (e: any) {
    return {
      ok: false,
      error: (e && e.message === 'auth_request_timeout') ? 'request_timeout' : 'request_failed'
    };
  }
  const data = await parseFunctionsInvokeResult(r);
  if (!data || !data.ok) {
    const detail =
      (data && (data.error || data.msg || data.message || data.code)) ||
      (r && r.error && r.error.message) ||
      'request_failed';
    return { ok: false, error: String(detail) };
  }
  return applySessionResponse(data, { state: 'session' });
}

/**
 * Claims an existing account for a Discord identity by proving the password.
 *
 * IRREVERSIBLE. On success the server destroys the password, its reversible
 * copy, every passkey and every backup code — Discord becomes the only way in
 * for that account. A `super_admin` receives a fresh set of backup codes in
 * the response, shown once, because they have no administrator above them to
 * unlink and reissue.
 *
 * `ticket` is the continuation ticket from an `unlinked` redemption, so the
 * password alone is never enough: the caller must also have just proved
 * control of the Discord account being attached.
 */
export async function claimWithDiscord(ticket: string, id: string, password: string): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await withTimeout(
      c.functions.invoke('auth-discord', { body: { action: 'claim', ticket: ticket, id: id, password: password } }),
      AUTH_REQUEST_TIMEOUT_MS
    );
  } catch (e: any) {
    return {
      ok: false,
      error: (e && e.message === 'auth_request_timeout') ? 'request_timeout' : 'request_failed'
    };
  }
  const data = await parseFunctionsInvokeResult(r);
  if (!data || !data.ok) {
    const detail =
      (data && (data.error || data.msg || data.message || data.code)) ||
      (r && r.error && r.error.message) ||
      'request_failed';
    return { ok: false, error: String(detail) };
  }
  return applySessionResponse(data, { state: 'session', claimed: true, backupCodes: data.backup_codes || null });
}

/**
 * super_admin recovery when Discord itself is the problem.
 *
 * Restricted server-side: every other account has an administrator above it
 * who can unlink and reissue a relink code, which is stronger because it
 * involves a second human. The super_admin has nobody above them.
 */
export async function loginWithBackupCodeDiscord(id: string, code: string): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await withTimeout(
      c.functions.invoke('auth-discord', { body: { action: 'backup-login', id: id, code: code } }),
      AUTH_REQUEST_TIMEOUT_MS
    );
  } catch (e: any) {
    return {
      ok: false,
      error: (e && e.message === 'auth_request_timeout') ? 'request_timeout' : 'request_failed'
    };
  }
  const data = await parseFunctionsInvokeResult(r);
  if (!data || !data.ok) return { ok: false, error: String((data && data.error) || 'request_failed') };
  return applySessionResponse(data, { state: 'session', backupCodesRemaining: data.backup_codes_remaining });
}

/** Signs out and clears sb-/supabase./gm_/fgf_ localStorage keys. */
export async function logout(): Promise<void> {
  const c = getClient();
  if (c) {
    try { await c.auth.signOut(); } catch (_) { /* ignore */ }
  }
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
    if (typeof localStorage !== 'undefined') {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('sb-') || k.startsWith('supabase.') || k.startsWith('gm_') || k.startsWith('fgf_'))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    }
  } catch (_) { /* ignore */ }
}

/** Anonymous player self-registration (gated by the tenant join code). */
export async function registerPlayer(id: string, password: string, uid: string, code: string): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await c.functions.invoke('player-register', {
      body: {
        id: (id || '').trim(),
        password: password || '',
        uid: (uid || '').trim(),
        code: (code || '').trim().toUpperCase()
      }
    });
  } catch (e) {
    return { ok: false, error: 'request_failed' };
  }
  const data = await parseFunctionsInvokeResult(r);
  if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'registration_failed' };
  return { ok: true, status: data.status || 'pending' };
}

/** Public guild creation request (super_admin reviewed). */
export async function submitGuildRequest(
  guildTag: string,
  serverNumber: string,
  adminId: string,
  discordHandle: string,
  note: string
): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  let r: any;
  try {
    r = await c.functions.invoke('guild-request', {
      body: {
        guildTag: (guildTag || '').trim().toUpperCase(),
        serverNumber: (serverNumber || '').trim(),
        adminId: (adminId || '').trim(),
        discordHandle: (discordHandle || '').trim(),
        note: (note || '').trim()
      }
    });
  } catch (e) {
    return { ok: false, error: 'request_failed' };
  }
  const data = await parseFunctionsInvokeResult(r);
  if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'request_failed' };
  return { ok: true };
}

/** Generates a tenant join code client-side (e.g. "FGF-7K2M-X9Q4"). */
export function generateJoinCode(prefix?: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = (): string => {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };
  return (prefix || 'FGF') + '-' + block() + '-' + block();
}

/** Admin account operations (update-role with layered DB fallbacks, or Edge). */
export async function adminAccounts(action: string, payload?: Record<string, any>): Promise<AuthResult> {
  const c = getClient();
  if (!c) return { ok: false, error: 'no_client' };
  const w = winAny();
  const body = Object.assign({ action: action }, payload || {});

  if (action === 'update-role' && payload && payload.id && payload.role) {
    const targetGuild = payload.guild === 'ALL' ? null : (payload.guild || null);
    let targetServer = payload.serverNumber || null;
    if (payload.role === 'server_admin' && !targetServer) {
      let gId = targetGuild;
      if (!gId && w.guildsData) {
        const accObj = (w.accountsList || []).find((a: any) => (a.id || '').toLowerCase() === (payload.id || '').toLowerCase());
        if (accObj) gId = accObj.guild;
      }
      if (gId) {
        const sNum = (w.guildsData && w.guildsData[gId] && w.guildsData[gId].server_number) ||
          (typeof localStorage !== 'undefined' ? localStorage.getItem('gm_server_number_' + gId) : null);
        if (sNum) targetServer = String(sNum);
      }
    }

    // Step 1: dedicated update-role action.
    try {
      const edgeRes = await c.functions.invoke('admin-accounts', {
        body: { action: 'update-role', id: payload.id, role: payload.role, guild: targetGuild, serverNumber: targetServer }
      });
      if (edgeRes && edgeRes.data && edgeRes.data.ok) return { ok: true, role: payload.role, server_number: targetServer };
    } catch (_) { /* fall through */ }

    // Step 2: create action (service_role sync without altering password).
    try {
      const createRes = await c.functions.invoke('admin-accounts', {
        body: {
          action: 'create',
          id: payload.id,
          password: 'Sync_Role_Update_' + Math.random().toString(36).slice(2, 10),
          role: payload.role,
          guild: targetGuild || 'ALPHA',
          serverNumber: targetServer
        }
      });
      if (createRes && createRes.data && createRes.data.ok) return { ok: true, role: payload.role, server_number: targetServer };
    } catch (_) { /* fall through */ }

    // Step 3: native gm_admin_upsert RPC.
    try {
      const { error: upsertErr } = await c.rpc('gm_admin_upsert', {
        p_id: payload.id, p_password: '', p_role: payload.role, p_guild: targetGuild
      });
      if (!upsertErr) {
        if (targetServer) {
          try { await c.from('accounts').update({ server_number: targetServer }).ilike('id', payload.id); } catch (_) { /* ignore */ }
        }
        return { ok: true, role: payload.role, server_number: targetServer };
      }
    } catch (rpcErr) {
      console.warn('gm_admin_upsert RPC attempt:', rpcErr);
    }

    // Step 4: direct accounts UPDATE.
    try {
      const updateFields: Record<string, unknown> = { role: payload.role };
      if (targetGuild !== undefined) updateFields.guild = targetGuild;
      if (targetServer) updateFields.server_number = targetServer;
      const { data: dbData, error: dbErr } = await c.from('accounts').update(updateFields).ilike('id', payload.id).select();
      if (!dbErr && dbData && dbData.length > 0) return { ok: true, role: payload.role, server_number: targetServer };
    } catch (_) { /* fall through to edge */ }
  }

  let r: any;
  try {
    r = await c.functions.invoke('admin-accounts', { body: body });
  } catch (e) {
    r = { error: e };
  }
  const data = r && r.data;
  if (!data || data.ok === false) {
    let errMsg = (data && data.error) || (r && r.error && r.error.message) || 'request_failed';
    if (r && r.error && r.error.context && typeof r.error.context.json === 'function') {
      try {
        const errJson = await r.error.context.json();
        if (errJson && errJson.error) errMsg = errJson.error + (errJson.message ? ': ' + errJson.message : '');
      } catch (_) { /* ignore */ }
    }
    return { ok: false, error: errMsg };
  }
  return data;
}
