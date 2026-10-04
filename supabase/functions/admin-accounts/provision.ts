/**
 * supabase/functions/admin-accounts/provision.ts
 *
 * Creating a new account with its shadow GoTrue user, and the passwords an
 * admin hands over. Used by `create` and `approve-guild-request`.
 */

import type { EdgeLogger } from "../_shared/logger.ts";
import { findUserByEmail } from "../_shared/pagination.ts";
import { emailFor, randomSecret } from "../_shared/shadow-session.ts";
import type { AdminClient } from "../_shared/db.ts";

// Readable alphabet (no 0/O, 1/l/I) with rejection sampling. Every password
// an admin hands over is generated here -- `create` and approve-guild-request
// -- because officers relay them by hand over Discord.
export function generatePassword(length: number): string {
  const chars = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ!@#$%";
  const limit = 256 - (256 % chars.length);
  let result = "";
  while (result.length < length) {
    const values = new Uint8Array(length * 2);
    crypto.getRandomValues(values);
    for (let i = 0; i < values.length && result.length < length; i++) {
      if (values[i] < limit) result += chars[values[i] % chars.length];
    }
  }
  return result;
}

export type ProvisionResult = { ok: true } | { ok: false; error: string; status: number };

/**
 * Creates a NEW account and its shadow GoTrue user. It never takes over an
 * existing one.
 *
 * The account row is written first, by `gm_admin_upsert`, which since
 * 20261003090434 is create-only: it raises 23505 when the id is taken (the
 * unique index on lower(id) makes that check atomic). Only once the id is ours
 * is the shadow user touched. The old order -- shadow first, then an upsert
 * that overwrote role, guild and password on conflict -- let any guild_admin
 * "create" the super_admin's id and receive a working password for it.
 */
export async function provisionNewAccount(
  admin: AdminClient,
  logger: EdgeLogger,
  account: { id: string; password: string; role: string; guild: string | null }
): Promise<ProvisionResult> {
  const { error: uErr } = await admin.rpc("gm_admin_upsert", {
    p_id: account.id,
    p_password: account.password,
    p_role: account.role,
    p_guild: account.guild,
  });
  if (uErr) {
    if (uErr.code === "23505") return { ok: false, error: "account_exists", status: 200 };
    logger.error("Failed gm_admin_upsert", uErr, { id: account.id });
    return { ok: false, error: "server_error", status: 500 };
  }

  const email = await emailFor(account.id);
  const secret = randomSecret();
  const meta = { app_role: account.role, account_id: account.id };
  const { data: created, error: cuErr } = await admin.auth.admin.createUser({
    email,
    password: secret,
    email_confirm: true,
    app_metadata: meta,
  });
  let uid = created?.user?.id;
  if (cuErr || !uid) {
    // A shadow user can outlive its account (an earlier deletion of the same
    // id). The account row above is new, so re-keying that orphan is safe.
    const ex = await findUserByEmail(admin, email);
    if (!ex) {
      logger.error("Failed to create shadow user for new account", cuErr, { email, id: account.id });
      // The row was created by this call a moment ago: remove it so the id
      // can be retried rather than left without a way to sign in.
      await admin.from("accounts").delete().eq("id", account.id);
      return { ok: false, error: "provision_failed", status: 500 };
    }
    uid = ex.id;
    await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
  }

  const { error: aErr } = await admin.rpc("gm_attach_shadow", {
    p_id: account.id,
    p_auth_user_id: uid,
    p_secret: secret,
  });
  if (aErr) {
    logger.error("Failed gm_attach_shadow", aErr, { id: account.id, uid });
    return { ok: false, error: "server_error", status: 500 };
  }
  return { ok: true };
}
