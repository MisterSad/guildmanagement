import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { establishShadowSession } from "../_shared/shadow-session.ts";
import { getValidatedEnv } from "../_shared/env.ts";

const LoginSchema = z.object({
  id: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});

const env = getValidatedEnv();
const SUPABASE_URL  = env.SUPABASE_URL;
const SERVICE_ROLE  = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = env.SUPABASE_ANON_KEY;

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("auth-login", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let id = "", password = "";
  try {
    const rawBody = await req.json();
    const parsed = LoginSchema.safeParse(rawBody);
    if (!parsed.success) return json({ ok: false, error: "missing_credentials" }, 400);
    id = parsed.data.id;
    password = parsed.data.password;
  } catch (err) {
    logger.error("Failed to parse JSON body", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // IP sliding window throttle: 60 attempts per 5 minutes. Shared with
  // auth-passkey (same login_throttle table, keyed purely by IP) — a
  // passkey sign-in costs 2 requests (options + verify) instead of 1, and
  // the conditional/autofill listener adds a background options call on
  // every page load, so this budget covers both password and passkey
  // login from the same IP, not just this one endpoint.
  const clientIp = extractClientIp(req.headers);
  const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 60, windowMs: 300_000 });
  if (!throttle.allowed) {
    logger.warn("IP rate limit exceeded on login", { ip: clientIp, id });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  const { data: loginRes, error: cErr } = await admin.rpc("gm_check_login", { p_id: id, p_password: password });
  if (cErr) {
    logger.error("Database check_login error", cErr, { id });
    return json({ ok: false, error: "server_error" }, 500);
  }
  
  const loginRow = Array.isArray(loginRes) ? loginRes[0] : loginRes;
  if (loginRow?.is_locked || loginRow?.error === "account_locked") {
    logger.warn("Locked account attempted sign-in", { id });
    return json({ ok: false, error: "account_locked" }, 200);
  }
  if (!loginRow || !loginRow.role) {
    logger.warn("Invalid credentials attempt", { id });
    return json({ ok: false, error: "invalid_credentials" }, 200);
  }

  const canonicalId = loginRow.canonical_id;
  const role = loginRow.role;
  const status = loginRow.status ?? "active";

  logger.setContext({ userId: canonicalId });

  // Pending player accounts cannot sign in until an admin approves them.
  if (status !== "active") {
    logger.warn("Pending account attempted sign-in", { id: canonicalId, status });
    return json({ ok: false, error: "pending_approval" }, 200);
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const shadowResult = await establishShadowSession(admin, anon, canonicalId, role, logger);
  if (!shadowResult.ok) {
    return json({ ok: false, error: shadowResult.error }, shadowResult.status);
  }

  // Surfaced so the client can offer to enroll a passkey right after a
  // successful password sign-in when the account doesn't have one yet.
  const { count: passkeyCount } = await admin
    .from("account_passkeys")
    .select("id", { count: "exact", head: true })
    .eq("account_id", canonicalId);

  logger.info("User signed in successfully", { canonicalId, role });

  return json({
    ok: true,
    role,
    id: canonicalId,
    has_passkey: (passkeyCount ?? 0) > 0,
    access_token: shadowResult.session.access_token,
    refresh_token: shadowResult.session.refresh_token,
    expires_at: shadowResult.session.expires_at,
  });
});
