import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp } from "../_shared/rate-limit.ts";

// Public, unauthenticated endpoint: anyone can submit a request to create a
// new guild. Real validation (format, uniqueness, volume cap) happens
// server-side in gm_submit_guild_request -- this function is just the HTTP
// front door plus IP rate-limiting, same shape as player-register/index.ts.
// A super_admin reviews every request manually via admin-accounts'
// approve-guild-request/reject-guild-request -- nothing here provisions
// anything on its own.
//
// Rate limiting is a private in-memory counter (not the shared, DB-backed
// checkAndRecordIpAttempt/login_throttle used by auth-login and
// admin-accounts) deliberately: that table sums attempts per-IP across every
// consumer, so a busy office IP hitting the login form a handful of times
// would also throttle its first-ever guild request. player-register has the
// exact same isolation requirement and solves it the same way.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const attemptLog = new Map<string, number[]>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 300_000;

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

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("guild-request", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const clientIp = extractClientIp(req.headers);
  if (rateLimited(clientIp)) {
    logger.warn("Rate limit exceeded on guild creation request", { ip: clientIp });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  let guildTag = "", serverNumber = "", adminId = "", discordHandle = "", note = "";
  try {
    const body = await req.json();
    guildTag = (body?.guildTag ?? "").toString().trim();
    serverNumber = (body?.serverNumber ?? "").toString().trim();
    adminId = (body?.adminId ?? "").toString().trim();
    discordHandle = (body?.discordHandle ?? "").toString().trim();
    note = (body?.note ?? "").toString().trim();
  } catch (err) {
    logger.error("Failed to parse guild request body", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (!guildTag || !serverNumber || !adminId || !discordHandle) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }
  if (!/^[A-Za-z0-9_]{2,12}$/.test(guildTag)) return json({ ok: false, error: "invalid_guild_tag" }, 200);
  if (!/^[0-9]{4}$/.test(serverNumber)) return json({ ok: false, error: "invalid_server_number" }, 200);
  if (adminId.length < 3 || adminId.length > 32) return json({ ok: false, error: "invalid_admin_id" }, 200);
  if (discordHandle.length < 2 || discordHandle.length > 40) return json({ ok: false, error: "invalid_discord_handle" }, 200);
  if (note.length > 500) return json({ ok: false, error: "note_too_long" }, 200);

  logger.info("Processing guild creation request", { guildTag, serverNumber, adminId });

  const { data, error } = await admin.rpc("gm_submit_guild_request", {
    p_guild_tag: guildTag,
    p_server_number: serverNumber,
    p_admin_id: adminId,
    p_discord_handle: discordHandle,
    p_note: note || null,
  });

  if (error) {
    logger.error("Error calling gm_submit_guild_request", error, { guildTag, adminId });
    return json({ ok: false, error: "server_error", message: error.message }, 500);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
  if (!row || !row.ok) {
    logger.warn("Guild creation request rejected by DB", { guildTag, error: row?.error });
    return json({ ok: false, error: row?.error || "request_failed" }, 200);
  }

  logger.info("Guild creation request submitted", { guildTag, adminId });
  return json({ ok: true });
});
