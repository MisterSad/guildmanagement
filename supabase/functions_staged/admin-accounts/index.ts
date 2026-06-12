/**
 * admin-accounts v2 — MULTI-TENANT (saas_strategy.md §5.3 / §6.2).
 *
 * ⚠️ STAGED — deploy only together with migrations_staged/ (see
 *    docs/cutover-runbook.md). Differences vs the live v1:
 *      - every action is scoped to the caller's guild (JWT guild_id claim)
 *      - `list` no longer returns passwords: the UI must switch from the
 *        "reveal" eye to a "regenerate" flow (create on an existing id
 *        regenerates the password, returned once in the response)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

function callerClaims(req: Request): { role: string | null; guildId: string | null } {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return { role: null, guildId: null };
  try {
    let p = m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    const payload = JSON.parse(atob(p));
    return {
      role: payload?.app_metadata?.app_role ?? null,
      guildId: payload?.app_metadata?.guild_id ?? null,
    };
  } catch {
    return { role: null, guildId: null };
  }
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")   return json({ ok: false, error: "method_not_allowed" }, 405);

  const caller = callerClaims(req);
  if (caller.role !== "R5" || !caller.guildId) return json({ ok: false, error: "forbidden" }, 403);
  const guildId = caller.guildId;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const action = (body?.action ?? "").toString();

  if (action === "list") {
    const { data, error } = await admin.rpc("gm_admin_list", { p_guild_id: guildId });
    if (error) return json({ ok: false, error: "server_error" }, 500);
    return json({ ok: true, accounts: data ?? [] });
  }

  if (action === "create") {
    const id = (body?.id ?? "").toString().trim();
    const password = (body?.password ?? "").toString();
    const accRole = (body?.role ?? "R4").toString();
    if (!id || !password) return json({ ok: false, error: "missing_fields" }, 400);

    // The id is globally unique; refuse silently hijacking another guild's id.
    const { data: existing } = await admin.rpc("gm_account_info", { p_id: id });
    const exRow = Array.isArray(existing) ? existing[0] : existing;
    if (exRow?.guild_id && exRow.guild_id !== guildId) {
      return json({ ok: false, error: "id_taken" }, 200);
    }

    const email = await emailFor(id);
    const secret = randomSecret();
    const meta = { app_role: accRole, account_id: id, guild_id: guildId };
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const { data: list } = await admin.auth.admin.listUsers();
      const ex = list?.users?.find((u: { email?: string }) => u.email === email);
      if (!ex) return json({ ok: false, error: "provision_failed" }, 500);
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: uErr } = await admin.rpc("gm_admin_upsert", {
      p_guild_id: guildId, p_id: id, p_password: password, p_role: accRole,
    });
    if (uErr) return json({ ok: false, error: "server_error" }, 500);
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) return json({ ok: false, error: "server_error" }, 500);
    return json({ ok: true });
  }

  if (action === "delete") {
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);
    const { data: uid, error } = await admin.rpc("gm_admin_delete", { p_guild_id: guildId, p_id: id });
    if (error) return json({ ok: false, error: "server_error" }, 500);
    if (uid) { try { await admin.auth.admin.deleteUser(uid as string); } catch (_) { /* ignore */ } }
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
