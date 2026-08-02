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

// Simple in-memory rate limiter: per-IP, sliding window.
// Edge Functions run per-isolate, so this bounds bursts per instance;
// the authoritative anti-abuse layer is the DB function (unique UID, etc.).
const attemptLog = new Map<string, number[]>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const hits = (attemptLog.get(ip) || []).filter((t) => t > windowStart);
  if (hits.length >= MAX_ATTEMPTS) {
    attemptLog.set(ip, hits);
    return true;
  }
  hits.push(now);
  attemptLog.set(ip, hits);
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  let id = "", password = "", uid = "", code = "";
  try {
    const body = await req.json();
    id = (body?.id ?? "").toString().trim();
    password = (body?.password ?? "").toString();
    uid = (body?.uid ?? "").toString().trim();
    code = (body?.code ?? "").toString().trim();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (!id || !password || !uid || !code) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }
  if (id.length < 3 || id.length > 32) return json({ ok: false, error: "invalid_identifier" }, 200);
  if (password.length < 8) return json({ ok: false, error: "weak_password" }, 200);
  if (!/^[0-9]{1,20}$/.test(uid)) return json({ ok: false, error: "invalid_uid" }, 200);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("gm_register_player", {
    p_id: id,
    p_password: password,
    p_uid: uid,
    p_join_code: code,
  });

  if (error) return json({ ok: false, error: "server_error", message: error.message }, 500);

  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string; status?: string } | null;
  if (!row || !row.ok) {
    return json({ ok: false, error: row?.error || "registration_failed" }, 200);
  }

  return json({ ok: true, status: row.status || "pending" });
});
