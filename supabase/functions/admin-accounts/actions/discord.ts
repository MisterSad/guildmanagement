/**
 * admin-accounts actions: detaching a Discord identity, and inviting an
 * additional admin.
 */

import { type Role, canManageAccount, isGuildInScope, maxAssignableRole } from "../../_shared/admin-authz.ts";
import { escapeLike } from "../../_shared/like.ts";
import { resolveAuditChannelId, postAuditMessage } from "../../_shared/discord-verification.ts";
import { getTargetCtx } from "../../_shared/registration-decision.ts";
import { randomBackupCode, sha256Hex } from "../../_shared/backup-codes.ts";
import {
  DiscordUnlinkSchema,
  RELINK_CODE_TTL_MS,
  AdminInviteSchema,
  INVITE_CODE_TTL_MS,
  MAX_OPEN_INVITES_PER_GUILD,
} from "../schemas.ts";
import type { AdminContext } from "../context.ts";

// ── Phase D6: detach a Discord identity and hand back a way in ──────────
//
// Peer unlink is permitted: canManageAccount already lets a guild_admin
// manage another guild_admin of the same guild, and the owner chose to keep
// that rather than centralise recovery on the super_admin. The safeguard is
// not restriction but visibility -- every unlink is written to the audit
// ledger AND announced on the guild's Discord audit channel, so it cannot
// happen quietly.
//
// The unlink and the relink code are issued in ONE transaction
// (gm_discord_unlink). A bare "remove the link" with no code to follow is
// not recovery, it is a way to strand a colleague -- so the RPC cannot do
// only the first half.
//
// `discord-unlink`
export async function discordUnlink(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
  const parsedUnlink = DiscordUnlinkSchema.safeParse(body);
  if (!parsedUnlink.success) return json({ ok: false, error: "missing_fields" }, 400);
  const id = parsedUnlink.data.id;

  const { data: targetAcc } = await admin
    .from("accounts")
    .select("id, role, guild, server_number")
    .ilike("id", escapeLike(id))
    .maybeSingle();
  if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

  const targetCtx = await getTargetCtx(admin, targetAcc);
  if (!canManageAccount(info, targetCtx)) {
    logger.warn("Forbidden attempt to unlink Discord", {
      callerRole: info.role,
      targetId: id,
      targetRole: targetAcc.role,
    });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  // Plaintext exists only in this response. The database sees the hash.
  const relinkCode = randomBackupCode();
  const expiresAt = new Date(Date.now() + RELINK_CODE_TTL_MS).toISOString();

  const { data: rows, error: rpcErr } = await admin.rpc("gm_discord_unlink", {
    p_account_id: targetAcc.id,
    p_code_hash: await sha256Hex(relinkCode),
    p_expires_at: expiresAt,
    p_actor: info.accountId ?? "unknown",
  });
  if (rpcErr) {
    logger.error("gm_discord_unlink failed", rpcErr, { targetId: targetAcc.id });
    return json({ ok: false, error: "server_error" }, 500);
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || row.ok !== true) {
    return json({ ok: false, error: row?.err || "unlink_failed" }, 200);
  }

  const previous = row.previous_discord_user_id as string | null;
  const targetGuild = (row.guild as string | null) ?? targetAcc.guild ?? null;

  // The ledger is the authoritative record; Discord is the notification.
  await admin.from("system_audit_logs").insert({
    level: "WARN",
    service: "admin-accounts",
    action_type: "discord_unlink",
    guild: targetGuild,
    user_identifier: info.accountId ?? null,
    message:
      `Discord link removed from ${targetAcc.id}` + (previous ? ` (was ${previous})` : " (no link was attached)"),
    metadata: {
      target_account: targetAcc.id,
      target_role: targetAcc.role,
      previous_discord_user_id: previous,
      actor_role: info.role,
      relink_code_expires_at: expiresAt,
    },
  });

  // Best-effort: a failed announcement must not fail the unlink, which has
  // already committed.
  if (targetGuild) {
    const channelId = await resolveAuditChannelId(admin, targetGuild);
    if (channelId) {
      await postAuditMessage(
        channelId,
        `🔓 **Discord link removed** — \`${targetAcc.id}\` (${targetAcc.role || "member"})` +
          (previous ? ` was linked to Discord id \`${previous}\`.` : ` had no Discord link attached.`) +
          `\nPerformed by \`${info.accountId ?? "unknown"}\`. A single-use relink code was issued and expires in 7 days.`
      );
    } else {
      logger.info("No Discord audit channel configured for guild", { guild: targetGuild });
    }
  }

  logger.info("Discord link removed", { targetId: targetAcc.id, previous });

  return json({
    ok: true,
    id: targetAcc.id,
    previous_discord_user_id: previous,
    relink_code: relinkCode,
    expires_at: expiresAt,
    announced: Boolean(targetGuild),
  });
}

// ── Phase D5: invite an additional admin ────────────────────────────────
//
// No dependence on a Discord server, and no mapping between FGF guilds and
// Discord servers: THE CODE IS THE LINK. Whoever redeems it gets a new
// account in that guild, with no password of any kind -- Discord-only from
// birth.
//
// Authorization reuses the existing matrix rather than inventing one:
// `maxAssignableRole` caps what the caller may grant (a guild_admin can
// never mint a server_admin), and `isGuildInScope` caps where.
//
// `issue-admin-invite`
export async function issueAdminInvite(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
  const parsedInvite = AdminInviteSchema.safeParse(body);
  if (!parsedInvite.success) return json({ ok: false, error: "missing_fields" }, 400);
  const targetGuild = parsedInvite.data.guild;
  // An invitation always names its guild. Without one the lookup below used
  // to query `id = undefined` and answer guild_not_found.
  if (!targetGuild) return json({ ok: false, error: "missing_fields" }, 400);
  const targetRole = parsedInvite.data.role as Role;

  const ceiling = maxAssignableRole(info.role);
  if (!ceiling) return json({ ok: false, error: "forbidden" }, 403);
  // Ordering of the four roles, most privileged first.
  const rank: Record<string, number> = { super_admin: 3, server_admin: 2, guild_admin: 1, member: 0 };
  if (rank[targetRole] > rank[ceiling]) {
    logger.warn("Attempt to invite above the caller's ceiling", { callerRole: info.role, targetRole });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const { data: guildRow } = await admin.from("guilds").select("id, server_number").eq("id", targetGuild).maybeSingle();
  if (!guildRow) return json({ ok: false, error: "guild_not_found" }, 404);

  if (!isGuildInScope(info, targetGuild, guildRow.server_number)) {
    logger.warn("Attempt to invite outside the caller's scope", { callerRole: info.role, targetGuild });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  // Plaintext exists only in this response.
  const inviteCode = randomBackupCode();
  const expiresAt = new Date(Date.now() + INVITE_CODE_TTL_MS).toISOString();

  const { data: rows, error: rpcErr } = await admin.rpc("gm_issue_admin_invite", {
    p_code_hash: await sha256Hex(inviteCode),
    p_guild: targetGuild,
    p_role: targetRole,
    p_issued_by: info.accountId ?? "unknown",
    p_expires_at: expiresAt,
    p_max_open: MAX_OPEN_INVITES_PER_GUILD,
  });
  if (rpcErr) {
    logger.error("gm_issue_admin_invite failed", rpcErr, { targetGuild, targetRole });
    return json({ ok: false, error: "server_error" }, 500);
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || row.ok !== true) {
    return json({ ok: false, error: row?.err || "issue_failed", open_codes: row?.open_codes ?? null }, 200);
  }

  await admin.from("system_audit_logs").insert({
    level: "WARN",
    service: "admin-accounts",
    action_type: "admin_invite_issued",
    guild: targetGuild,
    user_identifier: info.accountId ?? null,
    message: `Admin invitation issued for ${targetGuild} (${targetRole})`,
    metadata: {
      target_guild: targetGuild,
      target_role: targetRole,
      actor_role: info.role,
      open_codes: row.open_codes,
      expires_at: expiresAt,
    },
  });

  // Announced for the same reason an unlink is: provisioning an admin is a
  // privileged act, and the guild should be able to see it happen.
  const channelId = await resolveAuditChannelId(admin, targetGuild);
  if (channelId) {
    await postAuditMessage(
      channelId,
      `🎟️ **Admin invitation issued** — a single-use code for a new \`${targetRole}\` in \`${targetGuild}\`, ` +
        `created by \`${info.accountId ?? "unknown"}\` and valid for 7 days.`
    );
  }

  logger.info("Admin invitation issued", { targetGuild, targetRole, openCodes: row.open_codes });

  return json({
    ok: true,
    guild: targetGuild,
    role: targetRole,
    invite_code: inviteCode,
    expires_at: expiresAt,
    open_codes: row.open_codes,
    max_open_codes: MAX_OPEN_INVITES_PER_GUILD,
  });
}
