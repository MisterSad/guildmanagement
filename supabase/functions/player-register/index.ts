import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

function getDbErrorStatus(errCode: string): number {
  switch (errCode) {
    case "invalid_code":
    case "missing_fields":
      return 400;
    case "identifier_taken":
    case "uid_already_claimed":
      return 409;
    case "invalid_identifier":
    case "weak_password":
    case "invalid_uid":
    case "uid_not_in_guild":
      return 422;
    default:
      return 422;
  }
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("player-register", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Safe client IP extraction via _shared/rate-limit.ts (prioritizes cf-connecting-ip, nearest hop, x-real-ip)
  const clientIp = extractClientIp(req.headers);
  const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 5, windowMs: 60_000 });
  if (!throttle.allowed) {
    logger.warn("IP rate limit exceeded on player registration", { ip: clientIp });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  let id = "", password = "", uid = "", code = "";
  try {
    const body = await req.json();
    id = (body?.id ?? "").toString().trim();
    password = (body?.password ?? "").toString();
    uid = (body?.uid ?? "").toString().trim();
    code = (body?.code ?? "").toString().trim().toUpperCase();
  } catch (err) {
    logger.error("Failed to parse registration body", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (!id || !password || !uid || !code) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }
  if (id.length < 3 || id.length > 32) return json({ ok: false, error: "invalid_identifier" }, 422);
  if (password.length < 8) return json({ ok: false, error: "weak_password" }, 422);
  if (!/^[0-9]{1,20}$/.test(uid)) return json({ ok: false, error: "invalid_uid" }, 422);

  logger.setContext({ userId: id });
  logger.info("Processing player registration request", { id, uid, codeLength: code.length });

  const { data, error } = await admin.rpc("gm_register_player", {
    p_id: id,
    p_password: password,
    p_uid: uid,
    p_join_code: code,
  });

  if (error) {
    logger.error("Error calling gm_register_player", error, { id, uid });
    return json({ ok: false, error: "server_error", message: error.message }, 500);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string; status?: string } | null;
  if (!row || !row.ok) {
    const errCode = row?.error || "registration_failed";
    logger.warn("Player registration rejected by DB", { id, error: errCode });
    return json({ ok: false, error: errCode }, getDbErrorStatus(errCode));
  }

  logger.info("Player registered successfully", { id, uid, status: row.status });
  return json({ ok: true, status: row.status || "pending" });
});
