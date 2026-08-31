/**
 * supabase/functions/_shared/shadow-session.ts
 *
 * This app does NOT use Supabase Auth natively for real credentials — the
 * `accounts` table (custom, bcrypt password) is the source of truth. A
 * "shadow" GoTrue user (synthetic email, random secret the caller never
 * sees) exists purely so a real GoTrue JWT can be minted after the real
 * credential check succeeds. Extracted from auth-login/index.ts so any new
 * credential-check method (WebAuthn passkey, backup code) can issue an
 * identical session without duplicating this security-sensitive bridge.
 * Behavior is unchanged from the original — this is a pure extraction.
 */

import { findUserByEmail } from "./pagination.ts";
import type { EdgeLogger } from "./logger.ts";

export async function emailFor(id: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gm_${hex}@no-reply.guildmgmt.app`;
}

export function randomSecret(): string {
  const b = new Uint8Array(48);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type ShadowSessionResult =
  | { ok: true; session: { access_token: string; refresh_token: string; expires_at: number } }
  | { ok: false; error: string; status: number };

/**
 * Resolves (or provisions) the shadow GoTrue user for `canonicalId`, syncs
 * its app_metadata to the current role, and signs in as that shadow user to
 * mint a real GoTrue session. `admin` must be a service_role client, `anon`
 * an anon-key client (both `persistSession: false`).
 */
export async function establishShadowSession(
  // deno-lint-ignore no-explicit-any
  admin: any,
  // deno-lint-ignore no-explicit-any
  anon: any,
  canonicalId: string,
  role: string,
  logger: EdgeLogger
): Promise<ShadowSessionResult> {
  const meta = { app_role: role, account_id: canonicalId };
  const email = await emailFor(canonicalId);

  const { data: shadow, error: sErr } = await admin.rpc("gm_get_shadow", { p_id: canonicalId });
  if (sErr) {
    logger.error("Failed to get shadow user info", sErr, { id: canonicalId });
    return { ok: false, error: "server_error", status: 500 };
  }
  const row = Array.isArray(shadow) ? shadow[0] : shadow;
  let secret: string | null = row?.gotrue_secret ?? null;

  if (!row || !row.auth_user_id || !secret) {
    secret = randomSecret();
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const existing = await findUserByEmail(admin, email);
      if (!existing) {
        logger.error("Failed to provision shadow user", cuErr, { email, canonicalId });
        return { ok: false, error: "provision_failed", status: 500 };
      }
      uid = existing.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: canonicalId, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed to attach shadow user", aErr, { canonicalId, uid });
      return { ok: false, error: "server_error", status: 500 };
    }
  } else {
    await admin.auth.admin.updateUserById(row.auth_user_id, { app_metadata: meta });
  }

  let { data: signIn, error: siErr } = await anon.auth.signInWithPassword({ email, password: secret! });
  if (siErr && row?.auth_user_id && secret) {
    // Self-heal: GoTrue shadow user password may have diverged from
    // gotrue_secret_enc. Resync it and retry once.
    logger.warn("Password divergence detected, resyncing shadow password", { canonicalId });
    await admin.auth.admin.updateUserById(row.auth_user_id, { password: secret });
    const retry = await anon.auth.signInWithPassword({ email, password: secret });
    signIn = retry.data;
    siErr = retry.error;
  }
  if (siErr || !signIn?.session) {
    logger.error("Failed to establish GoTrue session", siErr, { canonicalId, email });
    return { ok: false, error: "session_failed", status: 500 };
  }

  logger.info("Shadow session established", { canonicalId, role });

  return {
    ok: true,
    session: {
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      expires_at: signIn.session.expires_at,
    },
  };
}
