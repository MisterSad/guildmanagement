/**
 * admin-accounts actions: listing, creating and changing accounts within the
 * caller's scope.
 */

import { findUserByEmail } from "../../_shared/pagination.ts";
import {
  canManageAccount,
  isGuildAdmin,
  isGuildInScope,
  isMember,
  isServerAdmin,
  isSuperAdmin,
} from "../../_shared/admin-authz.ts";
import { escapeLike } from "../../_shared/like.ts";
import { bumpSessionVersion, getTargetCtx } from "../../_shared/registration-decision.ts";
import { emailFor, randomSecret } from "../../_shared/shadow-session.ts";
import { generatePassword, provisionNewAccount } from "../provision.ts";
import { ResetPasswordSchema, CreateSchema, UpdateRoleSchema, DeleteSchema, UpdateGuildSchema } from "../schemas.ts";
import type { AdminContext } from "../context.ts";

/** `list` */
export async function list(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, callerGuild } = ctx;
  const { data, error } = await admin.rpc("gm_admin_list");
  if (error) {
    logger.error("Failed to list admin accounts", error);
    return json({ ok: false, error: "server_error" }, 500);
  }

  let accountsList = data ?? [];
  if (isGuildAdmin(info.role)) {
    const callerGuildNorm = callerGuild ? String(callerGuild).trim().toUpperCase() : "";
    accountsList = accountsList.filter(
      (acc: any) => acc.guild && callerGuildNorm && String(acc.guild).trim().toUpperCase() === callerGuildNorm
    );
  } else if (isServerAdmin(info.role)) {
    const { data: guildsOnServer } = await admin
      .from("guilds")
      .select("id")
      .eq("server_number", info.serverNumber || "");
    const allowedGuildIds = new Set((guildsOnServer || []).map((g: any) => String(g.id).trim().toUpperCase()));
    accountsList = accountsList.filter(
      (acc: any) =>
        (acc.guild && allowedGuildIds.has(String(acc.guild).trim().toUpperCase())) ||
        (acc.server_number && String(acc.server_number) === String(info.serverNumber))
    );
  }
  return json({ ok: true, accounts: accountsList });
}

/** `create` */
export async function create(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, callerGuild, body } = ctx;
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

  if (isGuildAdmin(info.role)) {
    accRole = "guild_admin";
    if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
    accGuild = callerGuild;
    accServerNum = info.serverNumber;
  } else if (isServerAdmin(info.role)) {
    // Clamped strictly to maxAssignableRole (guild_admin / member)
    const requestedRole = createParsed.data.role ?? "guild_admin";
    accRole = isMember(requestedRole) ? "member" : "guild_admin";
    if (requestedRole !== accRole) {
      logger.warn("Server admin attempted role elevation in account create; clamped to guild_admin", {
        requestedRole,
        clampedTo: accRole,
      });
    }
    if (!accGuild || accGuild === "ALL") {
      return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
    }
    const { data: g } = await admin.from("guilds").select("server_number").eq("id", accGuild).maybeSingle();
    const targetServer = g?.server_number ?? null;
    if (!isGuildInScope(info, accGuild, targetServer)) {
      logger.warn("Server admin attempted to create account for out-of-scope guild", {
        callerServer: info.serverNumber,
        targetGuild: accGuild,
        targetServer,
      });
      return json({ ok: false, error: "forbidden" }, 403);
    }
    accServerNum = info.serverNumber;
  } else {
    // Super admin
    accRole = createParsed.data.role ?? "guild_admin";
    accGuild = accGuild === "ALL" ? null : accGuild;
    if (isGuildAdmin(accRole) && (!accGuild || accGuild === "ALL")) {
      return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
    }
    if (isServerAdmin(accRole) && !accServerNum && accGuild) {
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

/** `update-role` */
export async function updateRole(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
  const updateRoleParsed = UpdateRoleSchema.safeParse(body);
  if (!updateRoleParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
  const id = updateRoleParsed.data.id;
  const newRole = updateRoleParsed.data.role;
  const serverNumber = updateRoleParsed.data.serverNumber ?? null;
  const guild = updateRoleParsed.data.guild;

  // Only Super Admin can change account roles
  if (!isSuperAdmin(info.role)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const { data: targetAcc } = await admin
    .from("accounts")
    .select("id, role, guild, server_number, auth_user_id")
    .ilike("id", escapeLike(id))
    .maybeSingle();

  if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

  let targetServerNumber = serverNumber;
  if (isServerAdmin(newRole) && !targetServerNumber) {
    const gId = guild !== undefined ? guild : targetAcc.guild;
    if (gId && gId !== "ALL") {
      const { data: g } = await admin.from("guilds").select("server_number").eq("id", gId).maybeSingle();
      if (g && g.server_number) targetServerNumber = g.server_number;
    }
  }

  const updateFields: Record<string, any> = {
    role: newRole,
  };
  if (guild !== undefined) {
    updateFields.guild = guild === "ALL" ? null : guild;
  }
  if (targetServerNumber !== undefined) {
    updateFields.server_number = targetServerNumber;
  }

  // M4: a role change bumps session_version so all previously issued JWT
  // claims for this account stop matching gm_session_is_valid().
  const { data: curVer } = await admin.from("accounts").select("session_version").eq("id", targetAcc.id).maybeSingle();
  const nextSessionVersion = ((curVer?.session_version ?? 0) | 0) + 1;
  updateFields.session_version = nextSessionVersion;

  const { error: updErr } = await admin.from("accounts").update(updateFields).eq("id", targetAcc.id);

  if (updErr) {
    logger.error("Failed to update account role", updErr, { id, newRole });
    return json({ ok: false, error: "server_error", message: updErr.message }, 500);
  }

  if (targetAcc.auth_user_id) {
    try {
      await admin.auth.admin.updateUserById(targetAcc.auth_user_id, {
        app_metadata: { app_role: newRole, account_id: targetAcc.id, session_version: nextSessionVersion },
      });
    } catch (err) {
      logger.warn("Failed to sync GoTrue app_role on update-role", { id: targetAcc.id, error: err });
    }
  }

  logger.info("Super Admin updated account role", { id: targetAcc.id, newRole, serverNumber: targetServerNumber });
  return json({ ok: true, role: newRole, server_number: targetServerNumber });
}

/** `delete` */
export async function deleteAccount(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
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
    logger.warn("Forbidden attempt to delete account", {
      callerRole: info.role,
      targetId: id,
      targetRole: targetAcc.role,
    });
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
    } catch (_) {
      /* GoTrue delete best-effort */
    }
  }

  logger.info("Admin deleted account", { deletedId: id });
  return json({ ok: true });
}

/** `update-guild` */
export async function updateGuild(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
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
    if (!isSuperAdmin(info.role)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
  } else {
    const { data: destG } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
    if (!destG) return json({ ok: false, error: "not_found" }, 404);
    if (!isGuildInScope(info, targetGuild, destG.server_number)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
  }

  if (isGuildAdmin(targetAcc.role) && !targetGuild) {
    return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
  }

  const { error } = await admin.from("accounts").update({ guild: targetGuild }).eq("id", id);
  if (error) {
    logger.error("Failed to update account guild", error, { id, targetGuild });
    return json({ ok: false, error: "server_error" }, 500);
  }

  logger.info("Admin updated account guild", { id, targetGuild });
  return json({ ok: true });
}

/** `reset-password` */
export async function resetPassword(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, body } = ctx;
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
    logger.warn("Forbidden attempt to reset target account password", {
      callerRole: info.role,
      targetId: id,
      targetRole: targetAcc.role,
    });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const canonicalId = targetAcc.id;
  // Always generate password server-side; ignore any client-supplied body.password
  const newPassword = randomSecret().slice(0, 16);
  const { data: rpcData, error: rpcErr } = await admin.rpc("gm_reset_account_password", {
    p_id: canonicalId,
    p_password: newPassword,
  });
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
    } catch (_) {
      /* best-effort */
    }
  } else if (!row?.auth_user_id) {
    const email = await emailFor(canonicalId);
    const secret = randomSecret();
    const meta = { app_role: targetAcc.role || "guild_admin", account_id: canonicalId };
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email,
      password: secret,
      email_confirm: true,
      app_metadata: meta,
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
