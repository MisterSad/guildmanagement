import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { findUserByEmail } from "../_shared/pagination.ts";
import { canManageAccount, maxAssignableRole, isGuildInScope, normalizeRole, Role } from "../_shared/admin-authz.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { escapeLike } from "../_shared/like.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { resolveAuditChannelId, postAuditMessage } from "../_shared/discord-verification.ts";
import {
  bumpSessionVersion,
  decideRegistration,
  emailFor,
  getTargetCtx,
  randomSecret,
} from "../_shared/registration-decision.ts";
import { randomBackupCode, sha256Hex, issueBackupCodes, BACKUP_CODE_COUNT } from "../_shared/backup-codes.ts";
import { isSessionRevoked } from "../_shared/session-epoch.ts";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

// Per-action body schemas. Field names/shape mirror the manual extraction
// this replaces exactly — only bounds and type-safety are new, no business
// logic changes.
const idField = z.string().trim().min(1).max(128);
const guildField = z.string().trim().min(1).max(64).nullish();
const ResetPasswordSchema = z.object({ id: idField });
const CreateSchema = z.object({
  id: idField,
  // Accepted and ignored, for clients built before the server generated it.
  password: z.string().max(256).optional(),
  serverNumber: z.string().trim().max(32).nullish(),
  guild: guildField,
  role: z.string().trim().max(32).optional(),
});
const UpdateRoleSchema = z.object({
  id: idField,
  role: z.string().trim().min(1).max(32),
  serverNumber: z.string().trim().max(32).nullish(),
  guild: guildField,
});
const DeleteSchema = z.object({ id: idField });
const DiscordUnlinkSchema = z.object({ id: idField });
/** A relink code has to survive a Discord conversation and a time zone. */
const RELINK_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AdminInviteSchema = z.object({
  guild: guildField,
  role: z.enum(["guild_admin", "server_admin", "super_admin"]),
});
/** Same window as a relink code: long enough to cross a Discord conversation. */
const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Outstanding invitations per guild. A guardrail in code, per the owner's
 * decision -- changing it is a migration, not a settings toggle someone can
 * quietly raise. BABE has 11 admins today, so 5 open at once is generous.
 */
const MAX_OPEN_INVITES_PER_GUILD = 5;
const UpdateGuildSchema = z.object({ id: idField, guild: guildField });
const SetJoinCodeSchema = z.object({ guild: guildField, code: z.string().trim().min(1).max(64) });
const GetJoinCodeSchema = z.object({ guild: guildField });
const ApproveRejectSchema = z.object({ id: idField });
const GuildRequestIdSchema = z.object({ id: z.string().trim().uuid() });
const RejectGuildRequestSchema = z.object({ id: z.string().trim().uuid(), reason: z.string().trim().max(500).nullish() });

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

// Strict normalization, imported from _shared/admin-authz.ts. Legacy ranks
// ('R5'/'R4') and the historical 'admin' alias now normalize to 'member'.

async function getCallerInfo(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<{ role: Role | null; accountId: string | null; guild: string | null; serverNumber: string | null }> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { role: null, accountId: null, guild: null, serverNumber: null };

  const jwt = match[1].trim();
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anonClient.auth.getUser(jwt);
  if (error || !user) return { role: null, accountId: null, guild: null, serverNumber: null };

  const { data: acc } = await admin
    .from("accounts")
    .select("id, role, guild, server_number, status, session_version")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc || acc.status !== "active") {
    return { role: null, accountId: null, guild: null, serverNumber: null };
  }

  // C1: refuse a token minted before the account's session_version was bumped.
  // Same absent-tolerant rule as gm_session_is_valid(); see
  // 20260926250000_real_session_revocation.sql. The epoch is read from the
  // token's own payload because getUser() answers from the live auth.users row,
  // whose value is always the freshly bumped one.
  if (isSessionRevoked(jwt, acc.session_version as number | null)) {
    return { role: null, accountId: null, guild: null, serverNumber: null };
  }

  const normalizedRole = normalizeRole(acc.role);

  let serverNumber = acc.server_number ?? null;
  if (!serverNumber && acc.guild) {
    const { data: g } = await admin
      .from("guilds")
      .select("server_number")
      .eq("id", acc.guild)
      .maybeSingle();
    if (g && g.server_number) {
      serverNumber = g.server_number;
    }
  }

  return {
    role: normalizedRole,
    accountId: acc.id ?? null,
    guild: acc.guild ?? null,
    serverNumber,
  };
}

// Readable alphabet (no 0/O, 1/l/I) with rejection sampling. Every password
// an admin hands over is generated here -- `create` and approve-guild-request
// -- because officers relay them by hand over Discord.
function generatePassword(length: number): string {
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

type ProvisionResult = { ok: true } | { ok: false; error: string; status: number };

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
async function provisionNewAccount(
  admin: ReturnType<typeof createClient>,
  logger: EdgeLogger,
  account: { id: string; password: string; role: string; guild: string | null },
): Promise<ProvisionResult> {
  const { error: uErr } = await admin.rpc("gm_admin_upsert", {
    p_id: account.id, p_password: account.password, p_role: account.role, p_guild: account.guild,
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
    email, password: secret, email_confirm: true, app_metadata: meta,
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

  const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: account.id, p_auth_user_id: uid, p_secret: secret });
  if (aErr) {
    logger.error("Failed gm_attach_shadow", aErr, { id: account.id, uid });
    return { ok: false, error: "server_error", status: 500 };
  }
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("admin-accounts", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const clientIp = extractClientIp(req.headers);
  const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 60, windowMs: 300_000 });
  if (!throttle.allowed) {
    logger.warn("IP rate limit exceeded on admin-accounts", { ip: clientIp });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  const info = await getCallerInfo(req, admin);

  if (!info.role || (info.role !== "guild_admin" && info.role !== "server_admin" && info.role !== "super_admin")) {
    logger.warn("Unauthorized admin-accounts call", { role: info.role });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  logger.setContext({ tenantId: info.guild, userId: info.accountId });
  const callerGuild = info.guild;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (err) {
    logger.error("Failed to parse request JSON", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const action = (body?.action ?? "").toString();

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
  if (action === "backup-codes-status" || action === "backup-codes-regenerate") {
    if (info.role !== "super_admin" || !info.accountId) {
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

  if (action === "list") {
    const { data, error } = await admin.rpc("gm_admin_list");
    if (error) {
      logger.error("Failed to list admin accounts", error);
      return json({ ok: false, error: "server_error" }, 500);
    }

    let accountsList = data ?? [];
    if (info.role === "guild_admin") {
      const callerGuildNorm = callerGuild ? String(callerGuild).trim().toUpperCase() : "";
      accountsList = accountsList.filter((acc: any) =>
        acc.guild && callerGuildNorm && String(acc.guild).trim().toUpperCase() === callerGuildNorm
      );
    } else if (info.role === "server_admin") {
      const { data: guildsOnServer } = await admin
        .from("guilds")
        .select("id")
        .eq("server_number", info.serverNumber || "");
      const allowedGuildIds = new Set((guildsOnServer || []).map((g: any) => String(g.id).trim().toUpperCase()));
      accountsList = accountsList.filter((acc: any) =>
        (acc.guild && allowedGuildIds.has(String(acc.guild).trim().toUpperCase())) ||
        (acc.server_number && String(acc.server_number) === String(info.serverNumber))
      );
    }
    return json({ ok: true, accounts: accountsList });
  }

  if (action === "reset-password") {
    const resetParsed = ResetPasswordSchema.safeParse(body);
    if (!resetParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = resetParsed.data.id;

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("id, role, guild, server_number, auth_user_id")
      .ilike("id", escapeLike(id))
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

    const targetCtx = await getTargetCtx(admin, targetAcc);
    if (!canManageAccount(info, targetCtx)) {
      logger.warn("Forbidden attempt to reset target account password", { callerRole: info.role, targetId: id, targetRole: targetAcc.role });
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const canonicalId = targetAcc.id;
    // Always generate password server-side; ignore any client-supplied body.password
    const newPassword = randomSecret().slice(0, 16);
    const { data: rpcData, error: rpcErr } = await admin.rpc("gm_reset_account_password", { p_id: canonicalId, p_password: newPassword });
    if (rpcErr) {
      logger.error("Error executing gm_reset_account_password", rpcErr, { canonicalId });
      return json({ ok: false, error: "server_error", message: rpcErr.message }, 500);
    }
    if (Array.isArray(rpcData) && rpcData.length > 0 && rpcData[0]?.ok === false) {
      return json({ ok: false, error: rpcData[0]?.error || "reset_failed" }, 200);
    }

    const { data: shadow } = await admin.rpc("gm_get_shadow", { p_id: canonicalId });
    const row = Array.isArray(shadow) ? shadow[0] : shadow;

    if (row?.auth_user_id && row?.gotrue_secret) {
      try {
        await admin.auth.admin.updateUserById(row.auth_user_id, { password: row.gotrue_secret });
      } catch (_) { /* best-effort */ }
    } else if (!row?.auth_user_id) {
      const email = await emailFor(canonicalId);
      const secret = randomSecret();
      const meta = { app_role: targetAcc.role || "guild_admin", account_id: canonicalId };
      const { data: created, error: cuErr } = await admin.auth.admin.createUser({
        email, password: secret, email_confirm: true, app_metadata: meta,
      });
      let uid = created?.user?.id;
      if (cuErr || !uid) {
        const ex = await findUserByEmail(admin, email);
        if (ex) {
          uid = ex.id;
          await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
        }
      }
      if (uid) {
        await admin.rpc("gm_attach_shadow", { p_id: canonicalId, p_auth_user_id: uid, p_secret: secret });
      }
    }

    // Invalidate previously issued sessions (M4) -- the account's password
    // just changed, so pre-reset access/refresh tokens must stop matching.
    await bumpSessionVersion(admin, canonicalId, targetAcc.role || "member", targetAcc.auth_user_id ?? null);

    logger.info("Admin reset account password", { targetId: canonicalId });
    return json({ ok: true, password: newPassword });
  }

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
  if (action === "discord-unlink") {
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
      logger.warn("Forbidden attempt to unlink Discord", { callerRole: info.role, targetId: id, targetRole: targetAcc.role });
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
      message: `Discord link removed from ${targetAcc.id}` + (previous ? ` (was ${previous})` : " (no link was attached)"),
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
  if (action === "issue-admin-invite") {
    const parsedInvite = AdminInviteSchema.safeParse(body);
    if (!parsedInvite.success) return json({ ok: false, error: "missing_fields" }, 400);
    const targetGuild = parsedInvite.data.guild;
    const targetRole = parsedInvite.data.role as Role;

    const ceiling = maxAssignableRole(info.role);
    if (!ceiling) return json({ ok: false, error: "forbidden" }, 403);
    // Ordering of the four roles, most privileged first.
    const rank: Record<string, number> = { super_admin: 3, server_admin: 2, guild_admin: 1, member: 0 };
    if (rank[targetRole] > rank[ceiling]) {
      logger.warn("Attempt to invite above the caller's ceiling", { callerRole: info.role, targetRole });
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const { data: guildRow } = await admin
      .from("guilds").select("id, server_number").eq("id", targetGuild).maybeSingle();
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

  if (action === "create") {
    const createParsed = CreateSchema.safeParse(body);
    if (!createParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = createParsed.data.id;
    // Generated here, exactly like `reset-password`, and returned once. The
    // client used to generate it and never display it, so every officer who
    // clicked "Generate Access" got an account nobody could sign in to.
    const password = generatePassword(16);
    const serverNumber = createParsed.data.serverNumber ?? null;

    let accRole = "guild_admin";
    let accGuild = createParsed.data.guild ?? null;
    let accServerNum = serverNumber;

    if (info.role === "guild_admin") {
      accRole = "guild_admin";
      if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
      accGuild = callerGuild;
      accServerNum = info.serverNumber;
    } else if (info.role === "server_admin") {
      // Clamped strictly to maxAssignableRole (guild_admin / member)
      const requestedRole = createParsed.data.role ?? "guild_admin";
      accRole = (requestedRole === "member") ? "member" : "guild_admin";
      if (requestedRole !== accRole) {
        logger.warn("Server admin attempted role elevation in account create; clamped to guild_admin", { requestedRole, clampedTo: accRole });
      }
      if (!accGuild || accGuild === "ALL") {
        return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
      }
      const { data: g } = await admin.from("guilds").select("server_number").eq("id", accGuild).maybeSingle();
      const targetServer = g?.server_number ?? null;
      if (!isGuildInScope(info, accGuild, targetServer)) {
        logger.warn("Server admin attempted to create account for out-of-scope guild", { callerServer: info.serverNumber, targetGuild: accGuild, targetServer });
        return json({ ok: false, error: "forbidden" }, 403);
      }
      accServerNum = info.serverNumber;
    } else {
      // Super admin
      accRole = createParsed.data.role ?? "guild_admin";
      accGuild = accGuild === "ALL" ? null : accGuild;
      if (accRole === "guild_admin" && (!accGuild || accGuild === "ALL")) {
        return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
      }
      if (accRole === "server_admin" && !accServerNum && accGuild) {
        const { data: g } = await admin.from("guilds").select("server_number").eq("id", accGuild).maybeSingle();
        if (g && g.server_number) accServerNum = g.server_number;
      }
    }

    const provisioned = await provisionNewAccount(admin, logger, { id, password, role: accRole, guild: accGuild });
    if (!provisioned.ok) {
      if (provisioned.error === "account_exists") {
        logger.warn("Account create refused: id already taken", { id, callerRole: info.role });
      }
      return json({ ok: false, error: provisioned.error }, provisioned.status);
    }

    if (accServerNum) {
      await admin.from("accounts").update({ server_number: accServerNum }).eq("id", id);
    }

    logger.info("Admin created account", { createdId: id, role: accRole, guild: accGuild, serverNumber: accServerNum });
    return json({ ok: true, password });
  }

  if (action === "update-role") {
    const updateRoleParsed = UpdateRoleSchema.safeParse(body);
    if (!updateRoleParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = updateRoleParsed.data.id;
    const newRole = updateRoleParsed.data.role;
    const serverNumber = updateRoleParsed.data.serverNumber ?? null;
    const guild = updateRoleParsed.data.guild;

    // Only Super Admin can change account roles
    if (info.role !== "super_admin") {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("id, role, guild, server_number, auth_user_id")
      .ilike("id", escapeLike(id))
      .maybeSingle();

    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

    let targetServerNumber = serverNumber;
    if (newRole === "server_admin" && !targetServerNumber) {
      const gId = (guild !== undefined ? guild : targetAcc.guild);
      if (gId && gId !== "ALL") {
        const { data: g } = await admin.from("guilds").select("server_number").eq("id", gId).maybeSingle();
        if (g && g.server_number) targetServerNumber = g.server_number;
      }
    }

    const updateFields: Record<string, any> = {
      role: newRole,
    };
    if (guild !== undefined) {
      updateFields.guild = (guild === "ALL" ? null : guild);
    }
    if (targetServerNumber !== undefined) {
      updateFields.server_number = targetServerNumber;
    }

    // M4: a role change bumps session_version so all previously issued JWT
    // claims for this account stop matching gm_session_is_valid().
    const { data: curVer } = await admin
      .from("accounts")
      .select("session_version")
      .eq("id", targetAcc.id)
      .maybeSingle();
    const nextSessionVersion = ((curVer?.session_version ?? 0) | 0) + 1;
    updateFields.session_version = nextSessionVersion;

    const { error: updErr } = await admin
      .from("accounts")
      .update(updateFields)
      .eq("id", targetAcc.id);

    if (updErr) {
      logger.error("Failed to update account role", updErr, { id, newRole });
      return json({ ok: false, error: "server_error", message: updErr.message }, 500);
    }

    if (targetAcc.auth_user_id) {
      try {
        await admin.auth.admin.updateUserById(targetAcc.auth_user_id, {
          app_metadata: { app_role: newRole, account_id: targetAcc.id, session_version: nextSessionVersion }
        });
      } catch (err) {
        logger.warn("Failed to sync GoTrue app_role on update-role", { id: targetAcc.id, error: err });
      }
    }

    logger.info("Super Admin updated account role", { id: targetAcc.id, newRole, serverNumber: targetServerNumber });
    return json({ ok: true, role: newRole, server_number: targetServerNumber });
  }

  if (action === "delete") {
    const deleteParsed = DeleteSchema.safeParse(body);
    if (!deleteParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = deleteParsed.data.id;

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("id, role, guild, server_number, auth_user_id")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

    const targetCtx = await getTargetCtx(admin, targetAcc);
    if (!canManageAccount(info, targetCtx)) {
      logger.warn("Forbidden attempt to delete account", { callerRole: info.role, targetId: id, targetRole: targetAcc.role });
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const { data: uid, error } = await admin.rpc("gm_admin_delete", { p_id: id });
    if (error) {
      logger.error("Failed gm_admin_delete", error, { id });
      return json({ ok: false, error: "server_error" }, 500);
    }
    if (uid) {
      try {
        await admin.auth.admin.deleteUser(uid as string);
      } catch (_) { /* GoTrue delete best-effort */ }
    }

    logger.info("Admin deleted account", { deletedId: id });
    return json({ ok: true });
  }

  if (action === "update-guild") {
    const updateGuildParsed = UpdateGuildSchema.safeParse(body);
    if (!updateGuildParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = updateGuildParsed.data.id;
    const guild = updateGuildParsed.data.guild ?? null;

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("id, role, guild, server_number")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

    const targetCtx = await getTargetCtx(admin, targetAcc);
    if (!canManageAccount(info, targetCtx)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const targetGuild = guild === "ALL" ? null : guild;
    if (targetGuild === null) {
      if (info.role !== "super_admin") {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    } else {
      const { data: destG } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
      if (!destG) return json({ ok: false, error: "not_found" }, 404);
      if (!isGuildInScope(info, targetGuild, destG.server_number)) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    if (targetAcc.role === "guild_admin" && !targetGuild) {
      return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
    }

    const { error } = await admin
      .from("accounts")
      .update({ guild: targetGuild })
      .eq("id", id);
    if (error) {
      logger.error("Failed to update account guild", error, { id, targetGuild });
      return json({ ok: false, error: "server_error" }, 500);
    }

    logger.info("Admin updated account guild", { id, targetGuild });
    return json({ ok: true });
  }

  if (action === "set-join-code") {
    const setJoinParsed = SetJoinCodeSchema.safeParse(body);
    if (!setJoinParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const guild = setJoinParsed.data.guild ?? null;
    const code = setJoinParsed.data.code;

    let targetGuild = guild;
    if (info.role === "guild_admin") {
      if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
      targetGuild = callerGuild;
    } else if (!targetGuild) {
      return json({ ok: false, error: "missing_fields" }, 400);
    } else if (info.role === "server_admin") {
      const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
      if (!isGuildInScope(info, targetGuild, g?.server_number ?? null)) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    const { data, error } = await admin.rpc("gm_set_join_code", {
      p_guild: targetGuild,
      p_code: code,
    });
    if (error) {
      logger.error("Failed to set join code", error, { targetGuild });
      return json({ ok: false, error: "server_error", message: error.message }, 500);
    }
    return json(data);
  }

  if (action === "get-join-code") {
    const getJoinParsed = GetJoinCodeSchema.safeParse(body);
    if (!getJoinParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const guild = getJoinParsed.data.guild ?? null;
    let targetGuild = guild;
    if (info.role === "guild_admin") {
      if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
      targetGuild = callerGuild;
    } else if (!targetGuild) {
      return json({ ok: false, error: "missing_fields" }, 400);
    } else if (info.role === "server_admin") {
      const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
      if (!isGuildInScope(info, targetGuild, g?.server_number ?? null)) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    const { data, error } = await admin.rpc("gm_get_join_code", {
      p_guild: targetGuild,
    });
    if (error) {
      logger.error("Failed to get join code", error, { targetGuild });
      return json({ ok: false, error: "server_error", message: error.message }, 500);
    }
    return json(data);
  }

  // Approve / reject a pending player registration. The whole decision --
  // authorization, shadow-user provisioning, epoch bump, audit row, DM -- lives
  // in _shared/registration-decision.ts, shared with the Discord buttons.
  if (action === "approve-registration" || action === "reject-registration") {
    const parsed = ApproveRejectSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const res = await decideRegistration(
      admin,
      logger,
      { role: info.role, guild: info.guild, serverNumber: info.serverNumber, accountId: info.accountId, via: "app" },
      parsed.data.id,
      action === "approve-registration" ? "approve" : "reject",
    );
    if (!res.ok) {
      return json({ ok: false, error: res.error, ...(res.message ? { message: res.message } : {}) }, res.status);
    }
    return json({ ok: true });
  }

  // ==========================================================================
  // Self-service guild creation (Phase 1: request + manual validation).
  // Reserved to super_admin -- a brand-new guild has no existing scope for a
  // server_admin/guild_admin to be "in scope" of yet.
  // ==========================================================================

  if (action === "list-guild-requests") {
    if (info.role !== "super_admin") return json({ ok: false, error: "forbidden" }, 403);

    const { data, error } = await admin
      .from("guild_creation_requests")
      .select("id, guild_tag, server_number, admin_id, discord_handle, note, status, reject_reason, created_at, reviewed_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      logger.error("Failed to list guild creation requests", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    return json({ ok: true, requests: data ?? [] });
  }

  if (action === "clear-resolved-guild-requests") {
    if (info.role !== "super_admin") return json({ ok: false, error: "forbidden" }, 403);

    // Only ever removes already-resolved rows (approved/rejected/expired) --
    // pending requests are never touched by this, so nothing awaiting review
    // can silently disappear.
    const { data, error } = await admin
      .from("guild_creation_requests")
      .delete()
      .neq("status", "pending")
      .select("id");

    if (error) {
      logger.error("Failed to clear resolved guild requests", error);
      return json({ ok: false, error: "server_error" }, 500);
    }

    logger.info("Cleared resolved guild requests", { count: (data ?? []).length, clearedBy: info.accountId });
    return json({ ok: true, count: (data ?? []).length });
  }

  if (action === "approve-guild-request") {
    if (info.role !== "super_admin") return json({ ok: false, error: "forbidden" }, 403);

    const parsed = GuildRequestIdSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "missing_fields" }, 400);

    const { data: approveData, error: approveErr } = await admin.rpc("gm_approve_guild_request", {
      p_request_id: parsed.data.id,
    });
    if (approveErr) {
      logger.error("Failed gm_approve_guild_request", approveErr, { requestId: parsed.data.id });
      return json({ ok: false, error: "server_error", message: approveErr.message }, 500);
    }
    const approveRow = (Array.isArray(approveData) ? approveData[0] : approveData) as
      | { ok?: boolean; error?: string; guild_tag?: string; admin_id?: string; server_number?: string }
      | null;
    if (!approveRow || !approveRow.ok) {
      return json({ ok: false, error: approveRow?.error || "approve_failed" }, 200);
    }

    const newAdminId = approveRow.admin_id!;
    const newGuildTag = approveRow.guild_tag!;
    const newPassword = generatePassword(12);

    // gm_approve_guild_request already refused a taken admin_id; the
    // create-only provisioning below closes the race behind that check.
    const provisioned = await provisionNewAccount(admin, logger, {
      id: newAdminId, password: newPassword, role: "guild_admin", guild: newGuildTag,
    });
    if (!provisioned.ok) {
      logger.error("Account provisioning failed on guild request approval", null, { newAdminId, newGuildTag, error: provisioned.error });
      return json({ ok: false, error: provisioned.error === "account_exists" ? "admin_id_taken" : provisioned.error }, provisioned.status);
    }

    await admin
      .from("guild_creation_requests")
      .update({ reviewed_by: info.accountId })
      .eq("id", parsed.data.id);

    logger.info("Guild creation request approved", { requestId: parsed.data.id, guildTag: newGuildTag, adminId: newAdminId, reviewedBy: info.accountId });
    return json({ ok: true, guild: newGuildTag, id: newAdminId, password: newPassword });
  }

  if (action === "reject-guild-request") {
    if (info.role !== "super_admin") return json({ ok: false, error: "forbidden" }, 403);

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

    await admin
      .from("guild_creation_requests")
      .update({ reviewed_by: info.accountId })
      .eq("id", parsed.data.id);

    logger.info("Guild creation request rejected", { requestId: parsed.data.id, reviewedBy: info.accountId });
    return json(rejectData);
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
