import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";

// Public, unauthenticated endpoint: anyone can submit a request to create a
// new guild. Real validation (format, uniqueness, volume cap) happens
// server-side in gm_submit_guild_request -- this function is just the HTTP
// front door plus IP rate-limiting, same shape as player-register/index.ts.
// A super_admin reviews every request manually via admin-accounts'
// approve-guild-request/reject-guild-request -- nothing here provisions
// anything on its own.
//
// Rate limiting uses the shared, database-backed sliding window.
//
// It used to be a private in-memory Map, justified in a comment that claimed
// "player-register has the exact same isolation requirement and solves it the
// same way". That was simply not true -- player-register has always called
// checkAndRecordIpAttempt. And the isolation the comment was protecting cost
// more than it bought: Edge isolates are ephemeral and scaled horizontally, so
// the Map gave "5 per isolate", which on the only unauthenticated endpoint
// that writes to the database is not a limit at all (finding B3).
//
// The real trade-off the old comment identified does exist: login_throttle sums
// attempts per IP across every consumer, so a busy office IP can arrive here
// already partly spent. That is the same cost player-register accepts, and a
// shared budget that works beats a private one that does not.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * FINDING B3, now closed: this limiter used to be a `Map` in module scope.
 * Edge isolates are ephemeral and scaled horizontally, so "5 per 5 minutes"
 * was really "5 per isolate" — and a fresh isolate starts with an empty Map.
 * On the only unauthenticated endpoint that writes to the database, that is
 * not a limit at all.
 *
 * It now shares the database-backed sliding window every other public endpoint
 * uses, which is the pattern `player-register` already had.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 300_000;

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
  const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: MAX_ATTEMPTS, windowMs: WINDOW_MS });
  if (!throttle.allowed) {
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
