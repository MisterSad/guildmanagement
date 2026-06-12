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

  let id = "", password = "";
  try {
    const body = await req.json();
    id = (body?.id ?? "").toString().trim();
    password = (body?.password ?? "").toString();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (!id || !password) return json({ ok: false, error: "missing_credentials" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data: role, error: cErr } = await admin.rpc("gm_check_login", { p_id: id, p_password: password });
  if (cErr) return json({ ok: false, error: "server_error" }, 500);
  if (!role) return json({ ok: false, error: "invalid_credentials" }, 200);

  const meta = { app_role: role, account_id: id };
  const email = await emailFor(id);
  const { data: shadow, error: sErr } = await admin.rpc("gm_get_shadow", { p_id: id });
  if (sErr) return json({ ok: false, error: "server_error" }, 500);
  const row = Array.isArray(shadow) ? shadow[0] : shadow;
  let secret: string | null = row?.gotrue_secret ?? null;

  if (!row || !row.auth_user_id || !secret) {
    secret = randomSecret();
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const { data: list } = await admin.auth.admin.listUsers();
      const existing = list?.users?.find((u: { email?: string }) => u.email === email);
      if (!existing) return json({ ok: false, error: "provision_failed" }, 500);
      uid = existing.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) return json({ ok: false, error: "server_error" }, 500);
  } else {
    await admin.auth.admin.updateUserById(row.auth_user_id, { app_metadata: meta });
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: signIn, error: siErr } = await anon.auth.signInWithPassword({ email, password: secret! });
  if (siErr || !signIn?.session) return json({ ok: false, error: "session_failed" }, 500);

  return json({
    ok: true,
    role,
    id,
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
    expires_at: signIn.session.expires_at,
  });
});
