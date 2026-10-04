import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { establishShadowSession } from "../_shared/shadow-session.ts";
import { getValidatedEnv } from "../_shared/env.ts";
import { serviceClient, anonClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";

const LoginSchema = z.object({
  id: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});

// Fails the cold start when a required variable is missing; nothing here reads it.
getValidatedEnv();

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

export async function handler(req: Request): Promise<Response> {
  const json = makeJson(req);
  const logger = new EdgeLogger("auth-login", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let id = "",
    password = "";
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

  const admin = serviceClient();

  // IP sliding window throttle: 60 attempts per 5 minutes, on the
  // login_throttle table auth-discord also counts against (keyed purely by IP).
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

  const anon = anonClient();
  const shadowResult = await establishShadowSession(admin, anon, canonicalId, role, logger);
  if (!shadowResult.ok) {
    return json({ ok: false, error: shadowResult.error }, shadowResult.status);
  }

  logger.info("User signed in successfully", { canonicalId, role });

  return json({
    ok: true,
    role,
    id: canonicalId,
    access_token: shadowResult.session.access_token,
    refresh_token: shadowResult.session.refresh_token,
    expires_at: shadowResult.session.expires_at,
  });
}

serveUnlessTest(handler);
