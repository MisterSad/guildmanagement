import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
 * This replaces the previous unsafe manual JWT decoding (C1 fix).
 */
async function getCallerInfo(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<{ role: string | null; accountId: string | null; guild: string | null }> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return { role: null, accountId: null, guild: null };

  const jwt = match[1];
  // Validate the JWT signature via Supabase auth endpoint (cryptographically safe)
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anonClient.auth.getUser(jwt);
  if (error || !user) return { role: null, accountId: null, guild: null };

  // Read the authoritative role and guild from the accounts table (not from JWT claims)
  const { data: acc } = await admin
    .from("accounts")
    .select("id, role, guild")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc) return { role: null, accountId: null, guild: null };

  return {
    role: acc.role ?? null,
    accountId: acc.id ?? null,
    guild: acc.guild ?? null,
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")   return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // FIX (C1): JWT validated cryptographically via auth.getUser(), not by manual base64 decode
  const info = await getCallerInfo(req, admin);
  if (!info.role) return json({ ok: false, error: "forbidden" }, 200);

  const callerGuild = info.guild;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 200); }
  const action = (body?.action ?? "").toString();

  // Verify subscription status for non-Super Admin (guild_admin) callers on mutations
  if (info.role === "guild_admin" && action !== "list" && action !== "get-password") {
    const active = await isSubscriptionActive(admin, callerGuild);
    if (!active) {
      return json({ ok: false, error: "subscription_expired" }, 200);
    }
  }

  if (action === "list") {
    const { data, error } = await admin.rpc("gm_admin_list");
    if (error) return json({ ok: false, error: "server_error" }, 200);

    // FIX (C8): gm_admin_list no longer returns passwords. No password field in the list response.
    let accountsList = data ?? [];
    if (info.role === "guild_admin") {
      // Filter list: only show accounts of the same guild.
      accountsList = accountsList.filter((acc: any) => {
        if (acc.guild === callerGuild) return true;
        return false;
      });
    }
    return json({ ok: true, accounts: accountsList });
  }

  // FIX (C8): New action to retrieve a single account's password on demand.
  // Caller must be super_admin, or a guild_admin owning the same guild as the target account.
  if (action === "get-password") {
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 200);

    // Fetch target account info to validate permissions
    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 200);

    if (info.role === "guild_admin") {
      // Guild admins cannot retrieve super_admin passwords and can only retrieve passwords for their own guild
      if (targetAcc.role === "super_admin" || targetAcc.guild !== callerGuild) {
        return json({ ok: false, error: "forbidden" }, 200);
      }
    }

    const { data: password, error: pErr } = await admin.rpc("gm_get_account_password", { p_id: id });
    if (pErr) return json({ ok: false, error: "server_error" }, 200);
    if (!password) return json({ ok: false, error: "not_found" }, 200);

    return json({ ok: true, password });
  }

  if (action === "create") {
    const id = (body?.id ?? "").toString().trim();
    const password = (body?.password ?? "").toString();
    if (!id || !password) return json({ ok: false, error: "missing_fields" }, 200);

    let accRole = "guild_admin";
    let accGuild = (body?.guild ?? null) as string | null;

    if (info.role === "guild_admin") {
      accRole = "guild_admin";
      if (!callerGuild) {
        return json({ ok: false, error: "forbidden" }, 200);
      }
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
      const { data: list } = await admin.auth.admin.listUsers();
      const ex = list?.users?.find((u: { email?: string }) => u.email === email);
      if (!ex) return json({ ok: false, error: "provision_failed" }, 200);
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: uErr } = await admin.rpc("gm_admin_upsert", { p_id: id, p_password: password, p_role: accRole, p_guild: accGuild });
    if (uErr) return json({ ok: false, error: "server_error" }, 200);

    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) return json({ ok: false, error: "server_error" }, 200);
    return json({ ok: true });
  }

  if (action === "delete") {
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 200);

    if (info.role === "guild_admin") {
      const { data: targetAcc } = await admin
        .from("accounts")
        .select("role, guild")
        .eq("id", id)
        .maybeSingle();
      if (!targetAcc) return json({ ok: false, error: "not_found" }, 200);
      if (targetAcc.role === "super_admin" || targetAcc.guild !== callerGuild) {
        return json({ ok: false, error: "forbidden" }, 200);
      }
    }

    const { data: uid, error } = await admin.rpc("gm_admin_delete", { p_id: id });
    if (error) return json({ ok: false, error: "server_error" }, 200);
    if (uid) { try { await admin.auth.admin.deleteUser(uid as string); } catch (_) { /* GoTrue delete best-effort */ } }
    return json({ ok: true });
  }

  if (action === "update-guild") {
    const id = (body?.id ?? "").toString().trim();
    const guild = (body?.guild ?? null) as string | null;
    if (!id) return json({ ok: false, error: "missing_fields" }, 200);

    const { data: targetAcc } = await admin
      .from("accounts")
      .select("role, guild")
      .eq("id", id)
      .maybeSingle();
    if (!targetAcc) return json({ ok: false, error: "not_found" }, 200);

    if (info.role === "guild_admin") {
      if (!callerGuild) {
        return json({ ok: false, error: "forbidden" }, 200);
      }
      if (targetAcc.role === "super_admin" || targetAcc.guild !== callerGuild || guild !== callerGuild) {
        return json({ ok: false, error: "forbidden" }, 200);
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
    if (error) return json({ ok: false, error: "server_error" }, 200);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 200);
});
