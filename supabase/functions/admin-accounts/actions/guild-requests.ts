/**
 * admin-accounts actions: self-service guild creation requests (super_admin
 * only). A brand-new guild has no existing scope for a server_admin or
 * guild_admin to be in scope of yet.
 */

import { isSuperAdmin } from "../../_shared/admin-authz.ts";
import { generatePassword, provisionNewAccount } from "../provision.ts";
import { GuildRequestIdSchema, RejectGuildRequestSchema } from "../schemas.ts";
import type { AdminContext } from "../context.ts";

/** `list-guild-requests` */
export async function listGuildRequests(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info } = ctx;
  if (!isSuperAdmin(info.role)) return json({ ok: false, error: "forbidden" }, 403);

  const { data, error } = await admin
    .from("guild_creation_requests")
    .select(
      "id, guild_tag, server_number, admin_id, discord_handle, note, status, reject_reason, created_at, reviewed_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    logger.error("Failed to list guild creation requests", error);
    return json({ ok: false, error: "server_error" }, 500);
  }
  return json({ ok: true, requests: data ?? [] });
}

/** `clear-resolved-guild-requests` */
export async function clearResolvedGuildRequests(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info } = ctx;
  if (!isSuperAdmin(info.role)) return json({ ok: false, error: "forbidden" }, 403);

  // Only ever removes already-resolved rows (approved/rejected/expired) --
  // pending requests are never touched by this, so nothing awaiting review
  // can silently disappear.
  const { data, error } = await admin.from("guild_creation_requests").delete().neq("status", "pending").select("id");

  if (error) {
    logger.error("Failed to clear resolved guild requests", error);
    return json({ ok: false, error: "server_error" }, 500);
  }

  logger.info("Cleared resolved guild requests", { count: (data ?? []).length, clearedBy: info.accountId });
  return json({ ok: true, count: (data ?? []).length });
}

/** `approve-guild-request` */
export async function approveGuildRequest(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
  if (!isSuperAdmin(info.role)) return json({ ok: false, error: "forbidden" }, 403);

  const parsed = GuildRequestIdSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "missing_fields" }, 400);

  const { data: approveData, error: approveErr } = await admin.rpc("gm_approve_guild_request", {
    p_request_id: parsed.data.id,
  });
  if (approveErr) {
    logger.error("Failed gm_approve_guild_request", approveErr, { requestId: parsed.data.id });
    return json({ ok: false, error: "server_error", message: approveErr.message }, 500);
  }
  const approveRow = (Array.isArray(approveData) ? approveData[0] : approveData) as {
    ok?: boolean;
    error?: string;
    guild_tag?: string;
    admin_id?: string;
    server_number?: string;
  } | null;
  if (!approveRow || !approveRow.ok) {
    return json({ ok: false, error: approveRow?.error || "approve_failed" }, 200);
  }

  const newAdminId = approveRow.admin_id!;
  const newGuildTag = approveRow.guild_tag!;
  const newPassword = generatePassword(12);

  // gm_approve_guild_request already refused a taken admin_id; the
  // create-only provisioning below closes the race behind that check.
  const provisioned = await provisionNewAccount(admin, logger, {
    id: newAdminId,
    password: newPassword,
    role: "guild_admin",
    guild: newGuildTag,
  });
  if (!provisioned.ok) {
    logger.error("Account provisioning failed on guild request approval", null, {
      newAdminId,
      newGuildTag,
      error: provisioned.error,
    });
    return json(
      { ok: false, error: provisioned.error === "account_exists" ? "admin_id_taken" : provisioned.error },
      provisioned.status
    );
  }

  await admin.from("guild_creation_requests").update({ reviewed_by: info.accountId }).eq("id", parsed.data.id);

  logger.info("Guild creation request approved", {
    requestId: parsed.data.id,
    guildTag: newGuildTag,
    adminId: newAdminId,
    reviewedBy: info.accountId,
  });
  return json({ ok: true, guild: newGuildTag, id: newAdminId, password: newPassword });
}

/** `reject-guild-request` */
export async function rejectGuildRequest(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
  if (!isSuperAdmin(info.role)) return json({ ok: false, error: "forbidden" }, 403);

  const parsed = RejectGuildRequestSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "missing_fields" }, 400);

  const { data: rejectData, error: rejectErr } = await admin.rpc("gm_reject_guild_request", {
    p_request_id: parsed.data.id,
    p_reason: parsed.data.reason ?? null,
  });
  if (rejectErr) {
    logger.error("Failed gm_reject_guild_request", rejectErr, { requestId: parsed.data.id });
    return json({ ok: false, error: "server_error", message: rejectErr.message }, 500);
  }

  await admin.from("guild_creation_requests").update({ reviewed_by: info.accountId }).eq("id", parsed.data.id);

  logger.info("Guild creation request rejected", { requestId: parsed.data.id, reviewedBy: info.accountId });
  return json(rejectData);
}
