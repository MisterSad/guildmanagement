import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { findUserByEmail } from "../_shared/pagination.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";

const LoginSchema = z.object({
  id: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
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

  // IP sliding window throttle: 30 attempts per 5 minutes
  const clientIp = extractClientIp(req.headers);
  const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 30, windowMs: 300_000 });
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

  const meta = { app_role: role, account_id: canonicalId };
  const email = await emailFor(canonicalId);
  const { data: shadow, error: sErr } = await admin.rpc("gm_get_shadow", { p_id: canonicalId });
  if (sErr) {
    logger.error("Failed to get shadow user info", sErr, { id: canonicalId });
    return json({ ok: false, error: "server_error" }, 500);
  }
  const row = Array.isArray(shadow) ? shadow[0] : shadow;
  let secret: string | null = row?.gotrue_secret ?? null;

  if (!row || !row.auth_user_id || !secret) {
    secret = randomSecret();
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email, password: secret, email_confirm: true, app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      // FIX (SEV-03): Use safe paginated user lookup instead of unpaginated listUsers()
      const existing = await findUserByEmail(admin, email);
      if (!existing) {
        logger.error("Failed to provision shadow user", cuErr, { email, canonicalId });
        return json({ ok: false, error: "provision_failed" }, 500);
      }
      uid = existing.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: canonicalId, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed to attach shadow user", aErr, { canonicalId, uid });
      return json({ ok: false, error: "server_error" }, 500);
    }
  } else {
    await admin.auth.admin.updateUserById(row.auth_user_id, { app_metadata: meta });
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  let { data: signIn, error: siErr } = await anon.auth.signInWithPassword({ email, password: secret! });
  if (siErr && row?.auth_user_id && secret) {
    // Self-heal: GoTrue shadow user password may have diverged from gotrue_secret. Resync it.
    logger.warn("Password divergence detected, resyncing shadow password", { canonicalId });
    await admin.auth.admin.updateUserById(row.auth_user_id, { password: secret });
    const retry = await anon.auth.signInWithPassword({ email, password: secret });
    signIn = retry.data;
    siErr = retry.error;
  }
  if (siErr || !signIn?.session) {
    logger.error("Failed to establish GoTrue session", siErr, { canonicalId, email });
    return json({ ok: false, error: "session_failed" }, 500);
  }

  logger.info("User signed in successfully", { canonicalId, role });

  return json({
    ok: true,
    role,
    id: canonicalId,
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
    expires_at: signIn.session.expires_at,
  });
});
