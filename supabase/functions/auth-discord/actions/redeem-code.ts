/**
 * supabase/functions/auth-discord/actions/redeem-code.ts
 *
 * `redeem-code`: a relink code (phase D6) or an admin invitation (phase D5).
 */

import { type EdgeLogger } from "../../_shared/logger.ts";
import { establishShadowSession } from "../../_shared/shadow-session.ts";
import { normalizeBackupCode, sha256Hex } from "../../_shared/backup-codes.ts";
import { anonClient } from "../../_shared/clients.ts";
import { RedeemCodeSchema } from "../config.ts";
import { makeJson } from "../http.ts";
import { consumeTicket, failContinuation, throttled } from "../tickets.ts";

// ── POST { action: "redeem-code", ticket, code } — phases D6 + D5 ──────────
//
// Two kinds of code arrive here:
//   * `relink`       — reattach an EXISTING account whose link was removed, or
//                      was never made (phase D6).
//   * `admin_invite` — provision a NEW admin account in a guild (phase D5).
//
// Both are spent together with a fresh Discord authorization, so possession of
// the code is never sufficient: the person must also prove control of the
// Discord account being attached.
//
// The kind is read first, without consuming: the two RPCs take different
// arguments and each enforces its own single-use semantics under FOR UPDATE.
// A race here loses nothing — the loser gets `code_invalid`, which is exactly
// what a spent code should return.
export async function handleRedeemCode(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = RedeemCodeSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "redeem-code")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);

  // Only the hash is ever compared; the plaintext existed once, in the
  // response that handed the code over.
  const codeHash = await sha256Hex(normalizeBackupCode(parsed.data.code));

  const { data: codeRow, error: lookupErr } = await admin
    .from("account_link_codes")
    .select("kind")
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (lookupErr) {
    logger.error("Failed to classify link code", lookupErr);
    return json({ ok: false, error: "server_error" }, 500);
  }
  if (!codeRow) return failContinuation(json, admin, logger, consumed, "code_invalid");

  let row: any;
  if (codeRow.kind === "admin_invite") {
    const { data, error } = await admin.rpc("gm_redeem_admin_invite", {
      p_code_hash: codeHash,
      p_discord_user_id: consumed.discordUserId,
      p_discord_username: consumed.discordUsername ?? "",
    });
    if (error) {
      logger.error("Failed to redeem admin invite", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    row = Array.isArray(data) ? data[0] : data;
  } else {
    const { data, error } = await admin.rpc("gm_redeem_relink_code", {
      p_code_hash: codeHash,
      p_discord_user_id: consumed.discordUserId,
    });
    if (error) {
      logger.error("Failed to redeem relink code", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    row = Array.isArray(data) ? data[0] : data;
  }

  if (!row || row.ok !== true) {
    logger.warn("Link code rejected", { kind: codeRow.kind, reason: row?.err ?? "unknown" });
    // `discord_already_linked` is surfaced verbatim: it is actionable, and it
    // describes the caller's own Discord account, not someone else's.
    return failContinuation(json, admin, logger, consumed, row?.err || "code_invalid");
  }

  const accountId = row.account_id as string;
  const role = (row.role as string) || "member";
  logger.setContext({ userId: accountId });

  const anon = anonClient();
  const shadow = await establishShadowSession(admin, anon, accountId, role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("Link code redeemed", {
    kind: codeRow.kind, accountId, role, discordUserId: consumed.discordUserId,
  });

  return json({
    ok: true,
    state: "session",
    kind: codeRow.kind,
    role,
    id: accountId,
    guild: row.guild ?? null,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}
