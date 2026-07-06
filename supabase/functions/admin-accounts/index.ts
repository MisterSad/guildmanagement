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

function callerInfo(req: Request): { role: string | null; accountId: string | null } {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return { role: null, accountId: null };
  try {
    let p = m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    const payload = JSON.parse(atob(p));
    return {
      role: payload?.app_metadata?.app_role ?? null,
      accountId: payload?.app_metadata?.account_id ?? null,
    };
  } catch {
    return { role: null, accountId: null };
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

  const info = callerInfo(req);
  if (!info.role) return json({ ok: false, error: "forbidden" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  let isAllowed = false;
  if (info.role === "R5") {
    isAllowed = true;
  } else if (info.role === "R4" && info.accountId) {
    const { data: accData } = await admin
      .from("accounts")
      .select("guild")
      .eq("id", info.accountId)
      .maybeSingle();
    if (accData && accData.guild === "ALPHA") {
      isAllowed = true;
    }
  }

  if (!isAllowed) return json({ ok: false, error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const action = (body?.action ?? "").toString();

  if (action === "list") {
    const { data, error } = await admin.rpc("gm_admin_list");
    if (error) return json({ ok: false, error: "server_error" }, 500);

    let accountsList = data ?? [];
    if (info.role === "R4") {
      accountsList = accountsList.map((acc: any) => {
        if (acc.role === "R5") {
          return { ...acc, password: "" }; // Obfuscate password for Super Admin
        }
        return acc;
      });
    }
    return json({ ok: true, accounts: accountsList });
  }

  if (action === "create") {
    const id = (body?.id ?? "").toString().trim();
    const password = (body?.password ?? "").toString();
    const accRole = (info.role === "R4") ? "R4" : (body?.role ?? "R4").toString();
    if (!id || !password) return json({ ok: false, error: "missing_fields" }, 400);

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
      if (!ex) return json({ ok: false, error: "provision_failed" }, 500);
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: uErr } = await admin.rpc("gm_admin_upsert", { p_id: id, p_password: password, p_role: accRole });
    if (uErr) return json({ ok: false, error: "server_error" }, 500);
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) return json({ ok: false, error: "server_error" }, 500);
    return json({ ok: true });
  }

  if (action === "delete") {
    const id = (body?.id ?? "").toString().trim();
    if (!id) return json({ ok: false, error: "missing_fields" }, 400);

    if (info.role === "R4") {
      const { data: targetAcc } = await admin
        .from("accounts")
        .select("role")
        .eq("id", id)
        .maybeSingle();
      if (targetAcc && targetAcc.role === "R5") {
        return json({ ok: false, error: "forbidden" }, 403);
      }
    }

    const { data: uid, error } = await admin.rpc("gm_admin_delete", { p_id: id });
    if (error) return json({ ok: false, error: "server_error" }, 500);
    if (uid) { try { await admin.auth.admin.deleteUser(uid as string); } catch (_) { /* ignore */ } }
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
