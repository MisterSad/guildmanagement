import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { findUserByEmail } from "../_shared/pagination.ts";
import { canManageAccount, maxAssignableRole, isGuildInScope, Role } from "../_shared/admin-authz.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";

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
  password: z.string().min(1).max(256),
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

function normalizeRole(r: string | null | undefined): Role {
  if (!r) return "member";
  const s = String(r).toLowerCase().trim();
  if (s === "super_admin" || s === "r5" || s === "admin") return "super_admin";
  if (s === "server_admin") return "server_admin";
  if (s === "guild_admin" || s === "r4") return "guild_admin";
  if (s === "member") return "member";
  return "member";
}

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
    .select("id, role, guild, server_number, status")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc || acc.status !== "active") {
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

async function getTargetCtx(
  admin: ReturnType<typeof createClient>,
  targetAcc: { role?: string | null; guild?: string | null; server_number?: string | null }
): Promise<{ role: Role | null; guild: string | null; serverNumber: string | null }> {
  let sNum = targetAcc.server_number ?? null;
  if (!sNum && targetAcc.guild) {
    const { data: g } = await admin
      .from("guilds")
      .select("server_number")
      .eq("id", targetAcc.guild)
      .maybeSingle();
    if (g?.server_number) {
      sNum = g.server_number;
    }
  }
  return {
    role: normalizeRole(targetAcc.role),
    guild: targetAcc.guild ?? null,
    serverNumber: sNum,
  };
}

async function emailFor(id: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gm_${hex}@no-reply.guildmgmt.app`;
}

function randomSecret(): string {
  const b = new Uint8Array(48);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Same alphabet/rejection-sampling shape as the client's generatePassword()
// in app.js -- used here because approve-guild-request generates the login
// credential server-side (the requester never chooses it themselves).
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
      .ilike("id", id)
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

    logger.info("Admin reset account password", { targetId: canonicalId });
    return json({ ok: true, password: newPassword });
  }

  if (action === "create") {
    const createParsed = CreateSchema.safeParse(body);
    if (!createParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = createParsed.data.id;
    const password = createParsed.data.password;
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

    const email = await emailFor(id);
    const secret = randomSecret();
    const meta = { app_role: accRole, account_id: id };
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const ex = await findUserByEmail(admin, email);
      if (!ex) {
        logger.error("Failed to create shadow user for new admin", cuErr, { email, id });
        return json({ ok: false, error: "provision_failed" }, 500);
      }
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: uErr } = await admin.rpc("gm_admin_upsert", { p_id: id, p_password: password, p_role: accRole, p_guild: accGuild });
    if (uErr) {
      logger.error("Failed gm_admin_upsert", uErr, { id });
      return json({ ok: false, error: "server_error" }, 500);
    }

    if (accServerNum) {
      await admin.from("accounts").update({ server_number: accServerNum }).eq("id", id);
    }

    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed gm_attach_shadow", aErr, { id, uid });
      return json({ ok: false, error: "server_error" }, 500);
    }

    logger.info("Admin created account", { createdId: id, role: accRole, guild: accGuild, serverNumber: accServerNum });
    return json({ ok: true });
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
      .ilike("id", id)
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
          app_metadata: { app_role: newRole, account_id: targetAcc.id }
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

  if (action === "approve-registration") {
    const approveParsed = ApproveRejectSchema.safeParse(body);
    if (!approveParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = approveParsed.data.id;

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild, server_number, status, id")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);
    if (targetAcc.status !== "pending" || targetAcc.role !== "member") {
      return json({ ok: false, error: "not_pending" }, 200);
    }

    const targetCtx = await getTargetCtx(admin, targetAcc);
    if (!canManageAccount(info, targetCtx)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const { data, error } = await admin.rpc("gm_approve_player_account", { p_id: id });
    if (error) {
      logger.error("Failed gm_approve_player_account", error, { id });
      return json({ ok: false, error: "server_error", message: error.message }, 500);
    }
    if (!data || data.ok !== true) {
      return json({ ok: false, error: data?.error || "approve_failed" }, 200);
    }

    const email = await emailFor(id);
    const secret = randomSecret();
    const meta = { app_role: "member", account_id: id };
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const ex = await findUserByEmail(admin, email);
      if (!ex) {
        logger.error("Failed to provision shadow user on approval", cuErr, { email, id });
        return json({ ok: false, error: "provision_failed" }, 500);
      }
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed gm_attach_shadow on approval", aErr, { id, uid });
      return json({ ok: false, error: "server_error" }, 500);
    }

    logger.info("Player registration approved", { id, guild: targetAcc.guild });
    return json({ ok: true });
  }

  if (action === "reject-registration") {
    const rejectParsed = ApproveRejectSchema.safeParse(body);
    if (!rejectParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
    const id = rejectParsed.data.id;

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild, server_number, status")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);
    if (targetAcc.status !== "pending" || targetAcc.role !== "member") {
      return json({ ok: false, error: "not_pending" }, 200);
    }

    const targetCtx = await getTargetCtx(admin, targetAcc);
    if (!canManageAccount(info, targetCtx)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const { data, error } = await admin.rpc("gm_reject_player_account", { p_id: id });
    if (error) {
      logger.error("Failed gm_reject_player_account", error, { id });
      return json({ ok: false, error: "server_error", message: error.message }, 500);
    }

    logger.info("Player registration rejected", { id, guild: targetAcc.guild });
    return json(data);
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

    const email = await emailFor(newAdminId);
    const secret = randomSecret();
    const meta = { app_role: "guild_admin", account_id: newAdminId };
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const ex = await findUserByEmail(admin, email);
      if (!ex) {
        logger.error("Failed to create shadow user for approved guild request", cuErr, { email, newAdminId });
        return json({ ok: false, error: "provision_failed" }, 500);
      }
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }

    const { error: uErr } = await admin.rpc("gm_admin_upsert", {
      p_id: newAdminId, p_password: newPassword, p_role: "guild_admin", p_guild: newGuildTag,
    });
    if (uErr) {
      logger.error("Failed gm_admin_upsert on guild request approval", uErr, { newAdminId, newGuildTag });
      return json({ ok: false, error: "server_error" }, 500);
    }

    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: newAdminId, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed gm_attach_shadow on guild request approval", aErr, { newAdminId, uid });
      return json({ ok: false, error: "server_error" }, 500);
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
