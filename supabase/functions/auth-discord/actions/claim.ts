/**
 * supabase/functions/auth-discord/actions/claim.ts
 *
 * `claim`: an existing password account becomes Discord-only (phase D3).
 */

import { type EdgeLogger } from "../../_shared/logger.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../../_shared/rate-limit.ts";
import { establishShadowSession } from "../../_shared/shadow-session.ts";
import { issueBackupCodes } from "../../_shared/backup-codes.ts";
import { anonClient } from "../../_shared/clients.ts";
import { isSuperAdmin } from "../../_shared/admin-authz.ts";
import { CLAIM_IP_LIMIT, CLAIM_DISCORD_LIMIT, ClaimSchema } from "../config.ts";
import { makeJson } from "../http.ts";
import { consumeTicket, failContinuation } from "../tickets.ts";

// ── POST { action: "claim", ticket, id, password } — phase D3 ───────────────
//
// IRREVERSIBLE. A successful claim destroys the password, the reversible
// `password_enc` copy and every backup code, in the same
// transaction that creates the link. One sign-in method at any instant.
//
// Three things stand between this and a password-guessing oracle: one Discord
// authorization buys at most MAX_TICKET_ATTEMPTS + 1 attempts (the chain cap,
// enforced by a CHECK in the table); a tighter per-IP budget than the other
// actions; and a per-Discord-account budget, failing closed, so rotating IPs
// buys nothing.
export async function handleClaim(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  const ip = extractClientIp(req.headers);
  const ipBudget = await checkAndRecordIpAttempt(admin, ip, CLAIM_IP_LIMIT);
  if (!ipBudget.allowed) {
    logger.warn("IP rate limit exceeded on claim", { ip });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);

  // Budget the Discord account itself, now that we know which one it is.
  const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const { data: tRows, error: tErr } = await admin.rpc("gm_check_discord_throttle", {
    p_discord_user_id: consumed.discordUserId,
    p_limit: CLAIM_DISCORD_LIMIT.limit,
    p_window_ms: CLAIM_DISCORD_LIMIT.windowMs,
    p_bucket: bucket,
  });
  const tRow = Array.isArray(tRows) ? tRows[0] : tRows;
  // Fails CLOSED. It used to fail open on the grounds that every attempt cost
  // a Discord round trip; a recoverable mistake now returns a fresh ticket, so
  // this budget is a real bound and a database error must not lift it.
  if (tErr || !tRow) {
    logger.error("Discord-account throttle unavailable on claim", tErr, { discordUserId: consumed.discordUserId });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }
  if (tRow.allowed === false) {
    logger.warn("Discord-account rate limit exceeded on claim", { discordUserId: consumed.discordUserId });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  const { data: rows, error } = await admin.rpc("gm_claim_account_with_discord", {
    p_id: parsed.data.id,
    p_password: parsed.data.password,
    p_discord_user_id: consumed.discordUserId,
  });
  if (error) {
    logger.error("Claim failed", error);
    return json({ ok: false, error: "server_error" }, 500);
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || row.ok !== true) {
    logger.warn("Claim rejected", { reason: row?.err ?? "unknown", id: parsed.data.id });
    return failContinuation(json, admin, logger, consumed, row?.err || "invalid_credentials");
  }

  const accountId = row.account_id as string;
  const role = (row.role as string) || "member";
  logger.setContext({ userId: accountId });

  // The claim just deleted this account's backup codes. A super_admin has no
  // administrator above them to unlink and reissue, so they must leave this
  // request holding a fresh set — it is their only recovery path once the
  // password is gone. Everyone else is covered by D6's relink code.
  let backupCodes: string[] | undefined;
  if (isSuperAdmin(role)) {
    try {
      backupCodes = await issueBackupCodes(admin, accountId);
    } catch (err) {
      logger.error("Failed to issue backup codes after a super_admin claim", err, { accountId });
    }
  }

  const anon = anonClient();
  const shadow = await establishShadowSession(admin, anon, accountId, role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("Account claimed with Discord", { accountId, role, discordUserId: consumed.discordUserId });

  return json({
    ok: true,
    state: "session",
    claimed: true,
    role,
    id: accountId,
    backup_codes: backupCodes,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}
