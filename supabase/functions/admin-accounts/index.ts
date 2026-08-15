import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { findUserByEmail } from "../_shared/pagination.ts";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Validate the JWT cryptographically using Supabase's auth.getUser(),
 * then fetch the caller's role and guild from the accounts table.
 */
async function getCallerInfo(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<{ role: string | null; accountId: string | null; guild: string | null; serverNumber: string | null }> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return { role: null, accountId: null, guild: null, serverNumber: null };

  const jwt = match[1].trim();
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anonClient.auth.getUser(jwt);
  if (error || !user) return { role: null, accountId: null, guild: null, serverNumber: null };

  const { data: acc } = await admin
    .from("accounts")
    .select("id, role, guild, server_number")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc) return { role: null, accountId: null, guild: null, serverNumber: null };

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
    role: acc.role ?? null,
    accountId: acc.id ?? null,
    guild: acc.guild ?? null,
    serverNumber,
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

async function isSubscriptionActive(admin: ReturnType<typeof createClient>, guildId: string | null): Promise<boolean> {
  if (!guildId) return true; // Super admin level / no guild restriction
  const { data } = await admin
    .from("guilds")
    .select("subscription_type, subscription_end")
    .eq("id", guildId)
    .maybeSingle();
  if (!data) return false;
  if (data.subscription_type === "Unlimited") return true;
  if (data.subscription_type === "Premium") {
    if (!data.subscription_end) return false;
    return new Date(data.subscription_end).getTime() >= Date.now();
  }
  return false;
}

Deno.serve(async (req: Request) => {
  const logger = new EdgeLogger("admin-accounts", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

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

  // Verify subscription status for non-Super Admin (guild_admin) callers on mutations
  if (info.role === "guild_admin" && action !== "list" && action !== "reset-password") {
    const active = await isSubscriptionActive(admin, callerGuild);
    if (!active) {
      logger.warn("Operation rejected: subscription expired", { guild: callerGuild, action });
      return json({ ok: false, error: "subscription_expired" }, 200);
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
      accountsList = accountsList.filter((acc: any) => acc.guild === callerGuild);
    } else if (info.role === "server_admin") {
      const { data: guildsOnServer } = await admin
        .from("guilds")
        .select("id")
        .eq("server_number", info.serverNumber || "");
      const allowedGuildIds = new Set((guildsOnServer || []).map((g: any) => g.id));
      accountsList = accountsList.filter((acc: any) => acc.guild && allowedGuildIds.has(acc.guild));
    }
    return json({ ok: true, accounts: accountsList });
  }

  if (action === "reset-password") {
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("id, role, guild, auth_user_id")
      .ilike("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

    if (info.role === "guild_admin") {
      if (targetAcc.role === "super_admin" || targetAcc.guild !== callerGuild) {
        logger.warn("Guild admin forbidden from resetting target account", { targetId: id, targetGuild: targetAcc.guild });
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    const canonicalId = targetAcc.id;
    const newPassword = (body?.password ?? randomSecret().slice(0, 16)).toString().trim();
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
        // FIX (SEV-03): Paginated search instead of unpaginated listUsers()
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
    const id = (body?.id ?? "").toString().trim();
    const password = (body?.password ?? "").toString();
    if (!id || !password) return json({ ok: false, error: "missing_fields" }, 400);

    let accRole = "guild_admin";
    let accGuild = (body?.guild ?? null) as string | null;

    if (info.role === "guild_admin") {
      accRole = "guild_admin";
      if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
      accGuild = callerGuild;
    } else {
      accRole = (body?.role ?? "guild_admin").toString();
      accGuild = accGuild === "ALL" ? null : accGuild;
      if (accRole === "guild_admin" && (!accGuild || accGuild === "ALL")) {
        return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
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
      // FIX (SEV-03): Paginated search
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

    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed gm_attach_shadow", aErr, { id, uid });
      return json({ ok: false, error: "server_error" }, 500);
    }

    logger.info("Admin created account", { createdId: id, role: accRole, guild: accGuild });
    return json({ ok: true });
  }

  if (action === "delete") {
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);

    if (info.role === "guild_admin") {
      const { data: targetAcc } = await admin
        .from("accounts")
        .select("role, guild")
        .eq("id", id)
        .maybeSingle();
      if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);
      if (targetAcc.role === "super_admin" || targetAcc.guild !== callerGuild) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
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
    const id = (body?.id ?? "").toString().trim();
    const guild = (body?.guild ?? null) as string | null;
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

    if (info.role === "guild_admin") {
      if (!callerGuild || targetAcc.role === "super_admin" || targetAcc.guild !== callerGuild || guild !== callerGuild) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    } else {
      if (targetAcc.role === "guild_admin" && (!guild || guild === "ALL")) {
        return json({ ok: false, error: "guild_admin_must_have_guild" }, 200);
      }
    }

    const targetGuild = guild === "ALL" ? null : guild;
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
    const guild = (body?.guild ?? null) as string | null;
    const code = (body?.code ?? "").toString().trim();
    if (!code) return json({ ok: false, error: "missing_fields" }, 400);

    let targetGuild = guild;
    if (info.role === "guild_admin") {
      if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
      targetGuild = callerGuild;
    } else if (!targetGuild) {
      return json({ ok: false, error: "missing_fields" }, 400);
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
    const guild = (body?.guild ?? null) as string | null;
    let targetGuild = guild;
    if (info.role === "guild_admin") {
      if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
      targetGuild = callerGuild;
    } else if (!targetGuild) {
      return json({ ok: false, error: "missing_fields" }, 400);
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
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild, status, id")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);
    if (targetAcc.status !== "pending" || targetAcc.role !== "member") {
      return json({ ok: false, error: "not_pending" }, 200);
    }
    if (info.role === "guild_admin" && targetAcc.guild !== callerGuild) {
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
      // FIX (SEV-03): Paginated search
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
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild, status")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);
    if (targetAcc.status !== "pending" || targetAcc.role !== "member") {
      return json({ ok: false, error: "not_pending" }, 200);
    }
    if (info.role === "guild_admin" && targetAcc.guild !== callerGuild) {
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

  return json({ ok: false, error: "unknown_action" }, 400);
});
