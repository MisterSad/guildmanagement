/**
 * admin-accounts actions: the super_admin's own recovery codes.
 */

import { isSuperAdmin } from "../../_shared/admin-authz.ts";
import { issueBackupCodes, BACKUP_CODE_COUNT } from "../../_shared/backup-codes.ts";
import type { AdminContext } from "../context.ts";

// ── Recovery codes, for the one account nobody can rescue ────────────────
//
// Restricted to the super_admin, matching `auth-discord`'s `backup-login`:
// every other account has an administrator above it who can unlink it and
// issue a relink code, which is stronger because it needs a second human.
// Issuing codes to anyone else would only create credentials that the sign-in
// path refuses anyway.
//
// Always the CALLER's own account, never a target id. An admin action that
// mints someone else's recovery codes is an account-takeover primitive.
//
// `backup-codes-status` / `backup-codes-regenerate`
export async function backupCodes(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, action } = ctx;
  if (!isSuperAdmin(info.role) || !info.accountId) {
    logger.warn("Recovery-code action refused", { role: info.role });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (action === "backup-codes-status") {
    const { count, error } = await admin
      .from("account_backup_codes")
      .select("account_id", { count: "exact", head: true })
      .eq("account_id", info.accountId)
      .is("used_at", null);
    if (error) {
      logger.error("Failed to count recovery codes", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    return json({ ok: true, remaining: count ?? 0, total: BACKUP_CODE_COUNT });
  }

  try {
    // Reissuing INVALIDATES the previous set, so a code written down last
    // year cannot outlive it. The plaintext is returned exactly once.
    const codes = await issueBackupCodes(admin, info.accountId);
    logger.info("Recovery codes reissued", { accountId: info.accountId, count: codes.length });
    return json({ ok: true, codes, total: BACKUP_CODE_COUNT });
  } catch (err) {
    logger.error("Failed to reissue recovery codes", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
}
