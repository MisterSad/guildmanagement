/**
 * supabase/functions/member-portal/index.ts
 *
 * The member portal's API: one POST endpoint, `{ action, payload }`. This file
 * does what every action shares -- parse, validate the payload (schemas.ts),
 * rate-limit by IP, resolve the player from the JWT -- and routes to the
 * action. The actions live in actions/, one module per area.
 */

import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import type { AdminClient } from "../_shared/db.ts";
import { resolveCaller } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";
import { RequestBodySchema, ActionPayloadSchemas } from "./schemas.ts";
import type { PlayerIdentity, PortalContext } from "./context.ts";
import { getActiveSessions, submitScores } from "./actions/sessions.ts";
import { updatePower, updateMetrics, getMetricsHistory, updateGlory, updateTimezone } from "./actions/profile.ts";
import { getTransferGuilds, submitTransferRequest } from "./actions/transfer.ts";
import { getHistory, getBadges, getWeeklyChallenges, getPersonalKpis } from "./actions/history.ts";
import { getAbsences, setAbsence, deleteAbsence } from "./actions/absences.ts";

export * from "./schemas.ts";

const ACTIONS: Record<string, (ctx: PortalContext) => Promise<Response>> = {
  "get-active-sessions": getActiveSessions,
  "submit-scores": submitScores,
  "update-power": updatePower,
  "update-metrics": updateMetrics,
  "get-metrics-history": getMetricsHistory,
  "update-glory": updateGlory,
  "get-transfer-guilds": getTransferGuilds,
  "submit-transfer-request": submitTransferRequest,
  "get-history": getHistory,
  "get-absences": getAbsences,
  "set-absence": setAbsence,
  "delete-absence": deleteAbsence,
  "get-badges": getBadges,
  "get-weekly-challenges": getWeeklyChallenges,
  "get-personal-kpis": getPersonalKpis,
  "update-timezone": updateTimezone,
};

// `confirm-discord-link` was removed on 2026-10-03 with the bot's /link
// command. It wrote discord_account_links outside every guard the Discord
// sign-in relies on: the password survived, the claim then refused the
// account for good, and a Discord identity could attach a second account
// without an admin relink code. Signing in with Discord now does the link.

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

/**
 * Resolves player identity cryptographically from the JWT via accounts.auth_user_id.
 */
async function getIdentity(
  req: Request,
  admin: AdminClient
): Promise<PlayerIdentity | null> {
  // One resolver for every function (_shared/auth.ts): JWT, active account,
  // session epoch (C1), normalised role.
  const caller = await resolveCaller(req, admin);
  if (!caller.role || !caller.accountId) return null;
  return {
    accountId: caller.accountId,
    role: caller.role,
    guild: caller.guild,
    // An account that never claimed a player is keyed by its own id.
    uid: caller.uid || caller.accountId,
  };
}

export async function handler(req: Request): Promise<Response> {
  const json = makeJson(req);
  const logger = new EdgeLogger("member-portal", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch (err) {
      logger.error("Failed to parse request JSON", err);
      return json({ ok: false, error: "bad_request" }, 400);
    }

    const bodyParsed = RequestBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      const hasAction = typeof (rawBody as any)?.action === "string" && (rawBody as any).action.trim().length > 0;
      return json({ ok: false, error: hasAction ? "bad_request" : "missing_action", issues: bodyParsed.error.issues }, 400);
    }

    const action = bodyParsed.data.action;
    let payload: any = (bodyParsed.data.payload && typeof bodyParsed.data.payload === "object") ? bodyParsed.data.payload : {};

    const schema = ActionPayloadSchemas[action];
    if (schema) {
      const payloadParsed = schema.safeParse(payload);
      if (!payloadParsed.success) {
        logger.warn("Payload validation failed for action", { action, issues: payloadParsed.error.issues });
        return json({
          ok: false,
          error: "invalid_payload",
          issues: payloadParsed.error.issues
        }, 422);
      }
      payload = payloadParsed.data;
    }

    const admin = serviceClient();

    const clientIp = extractClientIp(req.headers);
    const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 60, windowMs: 300_000 });
    if (!throttle.allowed) {
      logger.warn("IP rate limit exceeded on member-portal", { ip: clientIp, action });
      return json({ ok: false, error: "too_many_attempts" }, 429);
    }

    const identity = await getIdentity(req, admin);
    if (!identity || !identity.uid) {
      logger.warn("Unauthorized attempt to access member-portal", { action });
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const uid = identity.uid;
    logger.setContext({ tenantId: identity.guild, userId: uid });

    const run = ACTIONS[action];
    if (run) return await run({ admin, logger, json, identity, uid, payload });

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (unhandledErr) {
    logger.error("Unhandled member-portal error", unhandledErr);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

serveUnlessTest(handler);
