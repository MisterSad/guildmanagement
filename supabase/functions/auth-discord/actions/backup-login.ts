/**
 * supabase/functions/auth-discord/actions/backup-login.ts
 *
 * `backup-login`: the super_admin's recovery when Discord itself is the
 * problem.
 */

import { type EdgeLogger } from "../../_shared/logger.ts";
import { escapeLike } from "../../_shared/like.ts";
import { establishShadowSession } from "../../_shared/shadow-session.ts";
import { BACKUP_CODE_LENGTH, normalizeBackupCode, verifyAndConsumeBackupCode } from "../../_shared/backup-codes.ts";
import { anonClient } from "../../_shared/clients.ts";
import { isSuperAdmin } from "../../_shared/admin-authz.ts";
import { BackupLoginSchema } from "../config.ts";
import { makeJson } from "../http.ts";
import { throttled } from "../tickets.ts";

// ── POST { action: "backup-login", id, code } — phase D6 ────────────────────
//
// super_admin ONLY, and deliberately so. Every other account has an
// administrator above it who can unlink and reissue a relink code — a stronger
// path, because it puts a second human in the loop. For those accounts a backup
// code would only be a weaker credential sitting beside the strong one. The
// super_admin has nobody above them, so codes are their sole recovery.
//
// A non-super_admin gets `invalid_code`, identical to a wrong code: the reply
// must not double as a role oracle.
export async function handleBackupLogin(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = BackupLoginSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "backup-login")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const code = normalizeBackupCode(parsed.data.code);
  if (code.length !== BACKUP_CODE_LENGTH) return json({ ok: false, error: "invalid_code" }, 200);

  const { data: acc, error: aErr } = await admin
    .from("accounts")
    .select("id, role, status, locked_until")
    .ilike("id", escapeLike(parsed.data.id))
    .maybeSingle();
  if (aErr) {
    logger.error("Failed to load account for backup sign-in", aErr);
    return json({ ok: false, error: "server_error" }, 500);
  }
  if (!acc || acc.status !== "active" || !isSuperAdmin(acc.role)) {
    logger.warn("Backup sign-in refused", { id: parsed.data.id, reason: !acc ? "unknown" : !isSuperAdmin(acc.role) ? "not_super_admin" : "not_active" });
    return json({ ok: false, error: "invalid_code" }, 200);
  }
  if (acc.locked_until && new Date(acc.locked_until).getTime() > Date.now()) {
    logger.warn("Locked account attempted backup sign-in", { id: acc.id });
    return json({ ok: false, error: "account_locked" }, 200);
  }

  const consumed = await verifyAndConsumeBackupCode(admin, acc.id, code);
  if (!consumed.ok) {
    if (consumed.error === "server_error") return json({ ok: false, error: "server_error" }, 500);
    return json({ ok: false, error: "invalid_code" }, 200);
  }

  await admin
    .from("accounts")
    .update({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq("id", acc.id);

  const anon = anonClient();
  const shadow = await establishShadowSession(admin, anon, acc.id, acc.role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("super_admin signed in with a backup code", { accountId: acc.id, remaining: consumed.remaining });

  return json({
    ok: true,
    state: "session",
    role: acc.role,
    id: acc.id,
    backup_codes_remaining: consumed.remaining,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}
