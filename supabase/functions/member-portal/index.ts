import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { getPlayer } from "../_shared/member-lookup.ts";
import { isSessionRevoked } from "../_shared/session-epoch.ts";
import {
  MAX_ALLOWED_POWER,
  MAX_ALLOWED_EVENT_SCORE,
  parseSafeScore,
  participantEventName,
  isOfficerRecorded,
  warSubmissionRows,
  getWeekStartIso,
  eventScoringKey,
  logPlayerAction,
  updatePlayerPower,
  updatePlayerGlory,
  updatePlayerTimezone,
  getPlayerChallenges,
  listPlayerAbsences,
  setPlayerAbsence,
  deletePlayerAbsence,
} from "../_shared/player-actions.ts";

const SUPABASE_URL = typeof Deno !== "undefined" && Deno.env ? (Deno.env.get("SUPABASE_URL") || "") : "";
const ANON_KEY     = typeof Deno !== "undefined" && Deno.env ? (Deno.env.get("SUPABASE_ANON_KEY") || "") : "";
const SERVICE_ROLE = typeof Deno !== "undefined" && Deno.env ? (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "") : "";

// --- Zod Request and Action Payload Schemas ---

export const RequestBodySchema = z.object({
  action: z.string().trim().min(1, "action is required"),
  payload: z.unknown().optional(),
});

export const SubmitScoresSchema = z.object({
  event_name: z.string().trim().min(1, "event_name is required").max(64),
  session_id: z.string().trim().min(1, "session_id is required").max(64),
  participated: z.union([z.boolean(), z.number()]).optional(),
  score: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/).refine((val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    }, { message: `Score must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
  ]).optional(),
  score_prep: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/).refine((val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    }, { message: `Score prep must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
  ]).optional(),
  score_pvp: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/).refine((val) => {
      const parsed = parseSafeScore(val);
      return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
    }, { message: `Score pvp must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
  ]).optional(),
  late: z.union([z.boolean(), z.number()]).optional(),
}).passthrough();

export const UpdatePowerSchema = z.object({
  power: z.union([
    z.number().min(0).max(MAX_ALLOWED_POWER),
    z.string().regex(/^\s*\d+\s*$/)
  ]).refine((val) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 && n <= MAX_ALLOWED_POWER;
  }, { message: `Power must be between 0 and ${MAX_ALLOWED_POWER}` })
}).passthrough();

const metricPowerField = z.union([
  z.number().min(0).max(MAX_ALLOWED_POWER),
  z.string().regex(/^\s*\d+\s*$/)
]).refine((val) => {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n <= MAX_ALLOWED_POWER;
}, { message: `Power metric must be between 0 and ${MAX_ALLOWED_POWER}` }).optional();

const metricGloryField = z.union([
  z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
  z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
]).refine((val) => {
  const parsed = parseSafeScore(val);
  return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
}, { message: `Glory metric must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` }).optional();

export const UpdateMetricsSchema = z.object({
  total_power: metricPowerField,
  power: metricPowerField,
  tech_power: metricPowerField,
  champion_power: metricPowerField,
  crew_power: metricPowerField,
  flagship_power: metricPowerField,
  fleet_rating: metricPowerField,
  glory_score: metricGloryField,
}).passthrough();

export const GetMetricsHistorySchema = z.object({
  limit: z.union([
    z.number().int().min(1).max(100),
    z.string().regex(/^\d+$/).transform(v => parseInt(v, 10))
  ]).optional(),
}).passthrough();

export const UpdateGlorySchema = z.object({
  glory: z.union([
    z.number().min(0).max(MAX_ALLOWED_EVENT_SCORE),
    z.string().regex(/^\s*\d+(?:,\d+)*(?:\.\d+)?\s*$/)
  ]).refine((val) => {
    const parsed = parseSafeScore(val);
    return parsed !== null && parsed >= 0 && parsed <= MAX_ALLOWED_EVENT_SCORE;
  }, { message: `Glory score must be between 0 and ${MAX_ALLOWED_EVENT_SCORE}` })
}).passthrough();

export const SubmitTransferRequestSchema = z.object({
  targetGuild: z.string().trim().min(1, "targetGuild is required").max(32)
}).passthrough();

export const SetAbsenceSchema = z.object({
  start_date: z.string().trim().min(1, "start_date is required").max(32),
  end_date: z.string().trim().min(1, "end_date is required").max(32),
  kind: z.enum(["full", "partial", "war", "prep", "svs"]).optional().default("full"),
  note: z.string().trim().max(500).optional().default(""),
  id: z.string().trim().max(64).nullish(),
}).passthrough();

export const DeleteAbsenceSchema = z.object({
  id: z.string().trim().min(1, "id is required").max(64)
}).passthrough();

// Offsets are hours in quarter-hour steps: Adelaide is +9.5, Kathmandu +5.75.
// `.int()` used to reject every half-hour zone the portal itself offers.
const isQuarterHourOffset = (v: number) => Number.isFinite(v) && v >= -12 && v <= 14 && Number.isInteger(v * 4);

export const UpdateTimezoneSchema = z.object({
  offset: z.union([
    z.number().refine(isQuarterHourOffset, { message: "Offset must be between -12 and 14, in quarter hours" }),
    z.string().regex(/^-?\d+(\.\d+)?$/).transform(v => Number(v))
      .refine(isQuarterHourOffset, { message: "Offset must be between -12 and 14, in quarter hours" })
  ]),
  timezone: z.string().trim().max(64).optional()
}).passthrough();

export const ConfirmDiscordLinkSchema = z.object({
  code: z.string().trim().min(1, "code is required").max(64)
}).passthrough();

export const ActionPayloadSchemas: Record<string, z.ZodType<any>> = {
  "submit-scores": SubmitScoresSchema,
  "update-power": UpdatePowerSchema,
  "update-metrics": UpdateMetricsSchema,
  "get-metrics-history": GetMetricsHistorySchema,
  "update-glory": UpdateGlorySchema,
  "submit-transfer-request": SubmitTransferRequestSchema,
  "set-absence": SetAbsenceSchema,
  "delete-absence": DeleteAbsenceSchema,
  "update-timezone": UpdateTimezoneSchema,
  "confirm-discord-link": ConfirmDiscordLinkSchema,
};

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

interface PlayerIdentity {
  accountId: string;
  role: string;
  guild: string | null;
  uid: string | null;
}

/**
 * Resolves player identity cryptographically from the JWT via accounts.auth_user_id.
 */
async function getIdentity(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<PlayerIdentity | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return null;

  const jwt = match[1].trim();
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anonClient.auth.getUser(jwt);
  if (error || !user) return null;

  const { data: acc } = await admin
    .from("accounts")
    .select("id, role, guild, status, uid, session_version")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc || acc.status !== "active") return null;

  // C1: refuse a token minted before the account's session_version was bumped.
  // Same absent-tolerant rule as gm_session_is_valid(); see
  // 20260926250000_real_session_revocation.sql. The epoch is read from the
  // token's own payload because getUser() answers from the live auth.users row,
  // whose value is always the freshly bumped one.
  if (isSessionRevoked(jwt, acc.session_version as number | null)) {
    return null;
  }

  const accountId = acc.id as string;
  const role = (acc.role || "member") as string;
  const guild = (acc.guild || null) as string | null;

  // The player UID comes straight from the `accounts` row selected above.
  //
  // This used to call `gm_get_shadow(accountId)` first and prefer
  // `row?.player_uid`. That RPC returns only `(auth_user_id, gotrue_secret)` --
  // there is no `player_uid` column in its return type -- so the value was
  // always `undefined` and resolution always fell through to exactly the
  // expression below. The call was therefore pure overhead: one extra round
  // trip AND one `pgp_sym_decrypt` of the shadow GoTrue secret on every single
  // portal request, decrypting a credential for a value that was discarded.
  const playerUid = (acc.uid || accountId) as string;

  return {
    accountId,
    role,
    guild,
    uid: playerUid,
  };
}

async function getGuildAverages(
  admin: ReturnType<typeof createClient>,
  guild: string
): Promise<{
  avg_power: number;
  member_count: number;
  overall_power?: number;
  fleet_rating?: number;
  tech_power?: number;
  flagship_power?: number;
  champion_power?: number;
  crew_power?: number;
  glory_score?: number;
}> {
  try {
    const { data: members } = await admin
      .from("guild_members")
      .select("overall_power, fleet_rating, tech_power, flagship_power, champion_power, crew_power, glory_score")
      .eq("guild", guild);

    const count = members?.length || 0;
    const avgOf = (field: string): number => {
      if (count <= 0) return 0;
      const total = members?.reduce((sum: number, m: any) => sum + (Number(m[field]) || 0), 0) || 0;
      return Math.round(total / count);
    };
    const avgPower = avgOf("overall_power");

    // The guild attendance rate used to be computed here as
    //   attended rows / all rows
    // over EVERY event_participants row of the guild: no session
    // de-duplication, no week window, Glory included (it is 100% participated
    // by construction, 6,038 rows) and rows still awaiting approval included.
    // Measured on ALPHA it produced 48.1% while the admin's Stats page said
    // 31.6% for the same guild on the same data. A number a guild leader and a
    // guild member read differently is worse than no number.
    //
    // It now comes from gm_player_stats, on exactly the rules the admin side
    // uses. The unbounded scan of event_participants goes with it -- this
    // function ran it on three separate actions.
    return {
      avg_power: avgPower,
      member_count: count,
      overall_power: avgPower,
      fleet_rating: avgOf("fleet_rating"),
      tech_power: avgOf("tech_power"),
      flagship_power: avgOf("flagship_power"),
      champion_power: avgOf("champion_power"),
      crew_power: avgOf("crew_power"),
      glory_score: avgOf("glory_score")
    };
  } catch (_) {
    return { avg_power: 0, member_count: 0 };
  }
}

export async function handleRequest(req: Request): Promise<Response> {
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

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

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

    if (action === "get-active-sessions") {
      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) {
        return json({ ok: false, error: "player_not_found" }, 200);
      }

      const [activeSessionsRes, gloryRowsRes, guildAverages] = await Promise.all([
        admin
          .from("event_status")
          .select("event_name, session_id, start_at")
          .eq("guild", member.guild)
          .eq("is_active", true),
        admin
          .from("event_participants")
          .select("score")
          .eq("guild", member.guild)
          .eq("event_name", "Glory")
          .eq("week_start", getWeekStartIso(new Date()))
          .eq("pseudo", member.pseudo)
          .limit(1),
        getGuildAverages(admin, member.guild)
      ]);

      if (activeSessionsRes.error) {
        logger.error("DB error fetching active sessions", activeSessionsRes.error, { guild: member.guild });
        return json({ ok: false, error: "db_error" }, 200);
      }

      const activeSessions = activeSessionsRes.data;
      const gloryRow = gloryRowsRes.data?.[0] ?? null;

      let participantRows: any[] = [];
      if (activeSessions && activeSessions.length > 0) {
        const sessionIds = activeSessions.map((s: any) => s.session_id);
        const { data: pRows, error: pErr } = await admin
          .from("event_participants")
          .select("event_name, session_id, score, score_prep, score_pvp, participated, is_pending, late, excused, sub_present")
          .eq("guild", member.guild)
          .eq("pseudo", member.pseudo)
          .in("session_id", sessionIds);

        if (pErr) {
          logger.error("DB error fetching participant rows", pErr, { guild: member.guild, pseudo: member.pseudo });
          return json({ ok: false, error: "db_error" }, 200);
        }
        participantRows = pRows || [];
      }

      const merged = (activeSessions || []).map((s: any) => {
        const p = participantRows.find(
          (r) => r.event_name === participantEventName(s.event_name) && r.session_id === s.session_id
        );
        return {
          event_name: s.event_name,
          session_id: s.session_id,
          start_at: s.start_at,
          score: p ? p.score : 0,
          score_prep: p ? p.score_prep : 0,
          score_pvp: p ? p.score_pvp : 0,
          participated: p ? p.participated > 0 : false,
          is_pending: p ? p.is_pending : false,
          validated: p ? isOfficerRecorded(p) : false,
          in_session: !!p,
          late: p ? p.late : false,
          excused: p ? p.excused : false,
          sub_present: p ? p.sub_present : false
        };
      });

      return json({
        ok: true,
        pseudo: member.pseudo,
        guild: member.guild,
        sessions: merged,
        glory: {
          week_start: getWeekStartIso(new Date()),
          score: gloryRow?.score ?? 0,
        },
        overall_power: member.overall_power ?? 0,
        tech_power: member.tech_power ?? 0,
        champion_power: member.champion_power ?? 0,
        crew_power: member.crew_power ?? 0,
        flagship_power: member.flagship_power ?? 0,
        fleet_rating: member.fleet_rating ?? 0,
        glory_score: member.glory_score ?? 0,
        role: member.role ?? "R1",
        timezone_offset: member.timezone_offset ?? null,
        timezone: member.timezone ?? null,
        power_updated_at: member.power_updated_at ?? null,
        metrics_updated_at: member.metrics_updated_at ?? null,
        guild_averages: guildAverages
      });
    }

    if (action === "submit-scores") {
      const eventName = (payload?.event_name ?? "").toString().trim();
      const sessionId = (payload?.session_id ?? "").toString().trim();

      if (!eventName || !sessionId) {
        return json({ ok: false, error: "missing_parameters" }, 400);
      }

      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) {
        return json({ ok: false, error: "player_not_found" }, 400);
      }

      const { data: activeSessions, error: sErr } = await admin
        .from("event_status")
        .select("is_active")
        .eq("guild", member.guild)
        .eq("event_name", eventName)
        .eq("session_id", sessionId)
        .limit(1);

      const activeSession = activeSessions?.[0] ?? null;

      if (sErr || !activeSession || !activeSession.is_active) {
        return json({ ok: false, error: "session_inactive" }, 400);
      }

      const rowEventName = participantEventName(eventName);

      const { data: existingRows, error: exErr } = await admin
        .from("event_participants")
        .select("is_pending, participated, score, score_prep, score_pvp")
        .eq("guild", member.guild)
        .eq("event_name", rowEventName)
        .eq("session_id", sessionId)
        .eq("pseudo", member.pseudo)
        .limit(1);
      if (exErr) {
        logger.error("DB error reading participant row", exErr, { eventName, sessionId });
        return json({ ok: false, error: "db_error" }, 200);
      }

      const existing = existingRows?.[0] ?? null;

      // Starting an event creates a row for every member (and a Shadowfront
      // squad for every assigned player). No row means the player is not part
      // of this session -- say so, rather than update zero rows and report a
      // success, which is what every submission that ever "worked" did.
      if (!existing) {
        return json({ ok: false, error: "not_in_session" }, 400);
      }

      if (isOfficerRecorded(existing)) {
        return json({ ok: false, error: "score_already_validated" }, 400);
      }

      const update: Record<string, unknown> = {
        is_pending: true
      };

      if (payload.participated !== undefined) {
        update.participated = payload.participated ? 1 : 0;
      }

      if (payload.score !== undefined) {
        const parsed = parseSafeScore(payload.score);
        if (parsed !== null) update.score = parsed;
      }
      const prep = payload.score_prep !== undefined ? parseSafeScore(payload.score_prep) : null;
      const pvp = payload.score_pvp !== undefined ? parseSafeScore(payload.score_pvp) : null;
      if (payload.late !== undefined) {
        update.late = !!payload.late;
      }
      // Stripped client-supplied excused and appointed (sanction-evasion / attendance credit vectors)

      // A war session's daily grid is the single source of truth for the
      // prep/PvP columns: route the scores through it, as the officers' own
      // entry and the OCR do, instead of writing columns it would overwrite.
      let isWarSession = false;
      if ((eventName === "SvS" || eventName === "GvG") && (prep !== null || pvp !== null)) {
        const { data: warRows, error: warErr } = await admin
          .from("war_sessions")
          .select("session_id")
          .eq("guild", member.guild)
          .eq("event_name", eventName)
          .eq("session_id", sessionId)
          .limit(1);
        if (warErr) {
          logger.error("DB error checking war session", warErr, { guild: member.guild, eventName, sessionId });
          return json({ ok: false, error: "db_error" }, 200);
        }
        isWarSession = !!(warRows && warRows.length > 0);
      }

      if (isWarSession) {
        const rows = warSubmissionRows(member.pseudo, prep, pvp);
        if (rows.length > 0) {
          const { data: dsData, error: dsErr } = await admin.rpc("gm_upsert_daily_scores", {
            p_guild: member.guild,
            p_event_name: eventName,
            p_session_id: sessionId,
            p_rows: rows,
          });
          const dsRow = (Array.isArray(dsData) ? dsData[0] : dsData) as { ok?: boolean; error?: string } | null;
          if (dsErr || !dsRow || dsRow.ok !== true) {
            logger.error("Failed to record war scores", dsErr ?? dsRow?.error, { eventName, sessionId });
            return json({ ok: false, error: "update_failed" }, 200);
          }
          if (prep !== null && prep > 0) update.score_prep = prep;
          if (pvp !== null && pvp > 0) update.score_pvp = pvp;
          // The RPC derived score_prep/score_pvp/participated itself; only the
          // flags remain to be written below.
          if (update.participated === 0) delete update.participated;
        }
      } else {
        if (prep !== null) update.score_prep = prep;
        if (pvp !== null) update.score_pvp = pvp;
      }

      const rowUpdate = { ...update };
      if (isWarSession) {
        delete rowUpdate.score_prep;
        delete rowUpdate.score_pvp;
      }

      const { data: updatedRows, error: uErr } = await admin
        .from("event_participants")
        .update(rowUpdate)
        .eq("guild", member.guild)
        .eq("event_name", rowEventName)
        .eq("session_id", sessionId)
        .eq("pseudo", member.pseudo)
        .select("pseudo");

      if (uErr || !updatedRows || updatedRows.length === 0) {
        logger.error("Failed to update participant score", uErr, { eventName, sessionId });
        return json({ ok: false, error: "update_failed" }, 200);
      }

      const scoreParts: string[] = [];
      if (update.score_prep !== undefined) scoreParts.push(`Prep: ${Number(update.score_prep).toLocaleString()}`);
      if (update.score_pvp !== undefined) scoreParts.push(`PvP: ${Number(update.score_pvp).toLocaleString()}`);
      if (update.score !== undefined) scoreParts.push(`Score: ${Number(update.score).toLocaleString()}`);
      if (update.late) scoreParts.push("Late");
      const scoreSummary = scoreParts.length > 0 ? scoreParts.join(", ") : "Marked as participated";

      await logPlayerAction(admin, {
        action_type: "score_submission",
        pseudo: member.pseudo,
        uid,
        guild: member.guild,
        message: `Submitted scores for ${eventName} [${sessionId}]: ${scoreSummary}`,
        metadata: {
          event_name: eventName,
          session_id: sessionId,
          submitted_values: update,
          previous_is_pending: existing?.is_pending
        }
      });

      logger.info("Player submitted event scores", { pseudo: member.pseudo, eventName, sessionId });
      return json({ ok: true });
    }

    if (action === "update-power") {
      const res = await updatePlayerPower(admin, uid, identity.guild, payload?.power);
      if (!res.ok) {
        const status = res.error === "invalid_power" ? 400 : 200;
        logger.error("Failed to update player power", res.error, { uid });
        return json(res, status);
      }
      logger.info("Player updated power", { uid, power: res.power });
      return json(res);
    }

    if (action === "update-metrics") {
      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 200);

      function safeVal(val: unknown, fallback = 0): number {
        if (val === undefined || val === null || val === "") return fallback;
        const num = typeof val === "number" ? val : parseInt(String(val).replace(/[^0-9]/g, ""), 10);
        if (isNaN(num) || num < 0) return fallback;
        return Math.min(Math.round(num), MAX_ALLOWED_POWER);
      }

      const totalPower    = payload?.total_power !== undefined ? safeVal(payload.total_power) : (payload?.power !== undefined ? safeVal(payload.power) : member.overall_power);
      const techPower     = payload?.tech_power !== undefined ? safeVal(payload.tech_power) : (member.tech_power || 0);
      const championPower = payload?.champion_power !== undefined ? safeVal(payload.champion_power) : (member.champion_power || 0);
      const crewPower     = payload?.crew_power !== undefined ? safeVal(payload.crew_power) : (member.crew_power || 0);
      const flagshipPower = payload?.flagship_power !== undefined ? safeVal(payload.flagship_power) : (member.flagship_power || 0);
      const fleetRating   = payload?.fleet_rating !== undefined ? safeVal(payload.fleet_rating) : (member.fleet_rating || 0);
      const gloryScore    = payload?.glory_score !== undefined ? safeVal(payload.glory_score) : (member.glory_score || 0);

      const { data: rpcRes, error: rpcErr } = await admin.rpc("gm_upsert_player_metrics", {
        p_guild: member.guild,
        p_pseudo: member.pseudo,
        p_total_power: totalPower,
        p_tech_power: techPower,
        p_champion_power: championPower,
        p_crew_power: crewPower,
        p_flagship_power: flagshipPower,
        p_fleet_rating: fleetRating,
        p_glory_score: gloryScore,
      });

      if (rpcErr) {
        logger.error("Failed to update player metrics via rpc", rpcErr, { uid, pseudo: member.pseudo });
        return json({ ok: false, error: "update_failed" }, 200);
      }

      await logPlayerAction(admin, {
        action_type: "metrics_update",
        pseudo: member.pseudo,
        uid,
        guild: member.guild,
        message: `Updated military metrics: Power ${Number(totalPower).toLocaleString()}, Tech ${Number(techPower).toLocaleString()}, Champ ${Number(championPower).toLocaleString()}, Fleet ${Number(fleetRating).toLocaleString()}, Glory ${Number(gloryScore).toLocaleString()}`,
        metadata: {
          previous: {
            overall_power: member.overall_power,
            tech_power: member.tech_power,
            champion_power: member.champion_power,
            crew_power: member.crew_power,
            flagship_power: member.flagship_power,
            fleet_rating: member.fleet_rating,
            glory_score: member.glory_score
          },
          updated: {
            overall_power: totalPower,
            tech_power: techPower,
            champion_power: championPower,
            crew_power: crewPower,
            flagship_power: flagshipPower,
            fleet_rating: fleetRating,
            glory_score: gloryScore
          }
        }
      });

      logger.info("Player updated military metrics", { uid, pseudo: member.pseudo, totalPower, fleetRating });
      return json({
        ok: true,
        total_power: totalPower,
        tech_power: techPower,
        champion_power: championPower,
        crew_power: crewPower,
        flagship_power: flagshipPower,
        fleet_rating: fleetRating,
        glory_score: gloryScore,
      });
    }

    if (action === "get-metrics-history") {
      const limit = parseInt(payload?.limit, 10) || 12;
      const { data, error } = await admin.rpc("gm_get_player_metrics_history", {
        p_uid: uid,
        p_limit: limit,
      });
      if (error) {
        logger.error("Failed gm_get_player_metrics_history", error, { uid, limit });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; history?: unknown[] } | null;
      return json(row || { ok: true, history: [] });
    }

    if (action === "update-glory") {
      const res = await updatePlayerGlory(admin, uid, identity.guild, payload?.glory);
      if (!res.ok) {
        const status = res.error === "invalid_glory" ? 400 : (res.error === "player_not_found" ? 400 : 200);
        logger.error("Failed to update player glory", res.error, { uid });
        return json(res, status);
      }
      logger.info("Player updated weekly glory", { uid, week: res.week, glory: res.glory });
      return json(res);
    }

    if (action === "get-transfer-guilds") {
      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 200);

      // Same server, or any server sharing a currently-open cross-server
      // migration group with it — mirrors the admin "Transfer Member"
      // dialog (gm_list_transfer_eligible_guilds), so a player is never
      // offered a target the transfer RPC would reject.
      const { data: guilds, error: guildsErr } = await admin.rpc(
        "gm_list_transfer_eligible_guilds",
        { p_guild: member.guild }
      );

      if (guildsErr) {
        logger.error("Failed to fetch transfer guilds", guildsErr);
        return json({ ok: false, error: "db_error" }, 200);
      }

      return json({ ok: true, guilds: guilds ?? [] });
    }

    if (action === "submit-transfer-request") {
      const targetGuild = (payload?.targetGuild ?? "").toString().trim();
      if (!targetGuild) return json({ ok: false, error: "missing_target_guild" }, 400);

      const member = await getPlayer(admin, uid, identity.guild);

      const { data, error } = await admin.rpc("request_guild_transfer", {
        p_uid: uid,
        p_target_guild: targetGuild
      });

      if (error) {
        logger.error("Failed request_guild_transfer", error, { uid, targetGuild });
        return json({ ok: false, error: "rpc_failed" }, 200);
      }

      await logPlayerAction(admin, {
        action_type: "transfer_request",
        pseudo: member?.pseudo || uid,
        uid,
        guild: member?.guild || identity.guild || "UNKNOWN",
        message: `Requested guild transfer from ${member?.guild || identity.guild} to ${targetGuild}`,
        metadata: {
          source_guild: member?.guild || identity.guild,
          target_guild: targetGuild,
          result: data
        }
      });

      logger.info("Player submitted guild transfer request", { uid, targetGuild });
      return json(data);
    }

    if (action === "get-history") {
      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 200);

      const [memberRowsRes, guildParticipantsRes, guildAverages] = await Promise.all([
        admin
          .from("event_participants")
          .select("event_name, session_id, week_start, participated, score, score_prep, score_pvp, late, excused, sub_present, appointed")
          .eq("guild", member.guild)
          .eq("pseudo", member.pseudo)
          .order("week_start", { ascending: false }),
        admin
          .from("event_participants")
          .select("event_name, session_id, week_start, score, score_prep, score_pvp, participated, sub_present")
          .eq("guild", member.guild),
        getGuildAverages(admin, member.guild)
      ]);

      if (memberRowsRes.error) {
        logger.error("Failed to fetch player history", memberRowsRes.error);
        return json({ ok: false, error: "db_error" }, 200);
      }

      const rows = memberRowsRes.data || [];
      const allGuildParticipants = guildParticipantsRes.data || [];

      const guildSessionStats: Record<string, { totalScore: number; count: number; maxScore: number }> = {};
      allGuildParticipants.forEach((p: any) => {
        const evKey = (p.event_name || "").toUpperCase();
        const sKey = `${evKey}|${p.session_id || p.week_start || ""}`;
        const total = (Number(p.score) || 0) + (Number(p.score_prep) || 0) + (Number(p.score_pvp) || 0);
        if (!guildSessionStats[sKey]) {
          guildSessionStats[sKey] = { totalScore: 0, count: 0, maxScore: 0 };
        }
        if (total > 0 || p.participated > 0 || p.sub_present) {
          guildSessionStats[sKey].totalScore += total;
          guildSessionStats[sKey].count += 1;
          if (total > guildSessionStats[sKey].maxScore) {
            guildSessionStats[sKey].maxScore = total;
          }
        }
      });

      const byEvent: Record<string, any[]> = {};
      const hasScoreEvent = (name: string): boolean => {
        const n = (name || "").toUpperCase();
        if (n.indexOf("SVS") !== -1 || n.indexOf("GVG") !== -1) return true;
        if (n.indexOf("GLORY") !== -1) return true;
        return false;
      };

      rows.forEach((r: any) => {
        const key = (r.event_name || "Other").toUpperCase();
        if (!byEvent[key]) byEvent[key] = [];
        const sKey = `${key}|${r.session_id || r.week_start || ""}`;
        const sStats = guildSessionStats[sKey] || { totalScore: 0, count: 0, maxScore: 0 };
        const avgScore = sStats.count > 0 ? Math.round(sStats.totalScore / sStats.count) : 0;
        const playerScore = (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0);

        byEvent[key].push({
          session_id: r.session_id,
          week_start: r.week_start,
          participated: r.participated > 0,
          score: playerScore,
          guild_avg_score: avgScore,
          guild_max_score: sStats.maxScore,
          late: !!r.late,
          excused: !!r.excused,
          sub_present: !!r.sub_present,
          appointed: !!r.appointed
        });
      });

      const summary: Record<string, any> = {};
      Object.keys(byEvent).forEach((key) => {
        const list = byEvent[key];
        const total = list.length;
        const attended = list.filter((r: any) => r.participated || r.sub_present).length;
        summary[key] = {
          count: total,
          attended: attended,
          rate: total > 0 ? Math.round((attended / total) * 100) : 0,
          has_score: hasScoreEvent(key),
          history: list.slice(0, 60)
        };
      });

      return json({ ok: true, events: summary, guild_averages: guildAverages, overall: rows.length });
    }

    if (action === "get-absences") {
      const res = await listPlayerAbsences(admin, uid);
      if (!res.ok) {
        logger.error("Failed to list player absences", res.error, { uid });
        return json(res, 200);
      }
      return json(res);
    }

    if (action === "set-absence") {
      const startDate = (payload?.start_date ?? "").toString().trim();
      const endDate = (payload?.end_date ?? "").toString().trim();
      const kind = (payload?.kind ?? "full").toString().trim();
      const note = (payload?.note ?? "").toString().trim();
      const absenceId = payload?.id ? (payload.id).toString().trim() : null;

      const res = await setPlayerAbsence(admin, uid, identity.guild, { startDate, endDate, kind, note, id: absenceId });
      if (!res.ok) {
        const status = (res.error === "missing_dates" || res.error === "invalid_kind") ? 400 : (res.error === "player_not_found" ? 400 : 200);
        logger.error("Failed to set player absence", res.error, { uid });
        return json(res, status);
      }
      return json(res);
    }

    if (action === "delete-absence") {
      const absenceId = (payload?.id ?? "").toString().trim();
      const res = await deletePlayerAbsence(admin, uid, identity.guild, absenceId);
      if (!res.ok) {
        const status = res.error === "missing_id" ? 400 : 200;
        logger.error("Failed to delete player absence", res.error, { uid, absenceId });
        return json(res, status);
      }
      return json(res);
    }

    if (action === "get-badges") {
      const { data: fullRows, error: fErr } = await admin
        .from("guild_members")
        .select("pseudo, guild, role, created_at, overall_power")
        .eq("uid", uid)
        .limit(1);
      const full = fullRows?.[0] ?? null;
      if (fErr || !full) return json({ ok: false, error: "player_not_found" }, 200);

      const { data: attendRows, error: cErr } = await admin
        .from("event_participants")
        .select("event_name, session_id, week_start")
        .eq("guild", full.guild ?? identity.guild)
        .eq("pseudo", full.pseudo)
        .or("participated.gt.0,sub_present.eq.true");

      if (cErr) {
        logger.error("Failed to fetch badge attendance rows", cErr);
        return json({ ok: false, error: "db_error" }, 200);
      }

      const attendedKeys = new Set<string>();
      for (const row of attendRows ?? []) {
        const key = eventScoringKey(row.event_name, row.session_id, row.week_start);
        if (key) attendedKeys.add(key);
      }
      const attended = attendedKeys.size;

      const { data: gloryRows, error: gErr } = await admin
        .from("event_participants")
        .select("score, week_start")
        .eq("guild", full.guild ?? identity.guild)
        .eq("pseudo", full.pseudo)
        .eq("event_name", "Glory")
        .gt("score", 0)
        .order("week_start", { ascending: true });

      if (gErr) {
        logger.error("Failed to fetch badge glory rows", gErr);
        return json({ ok: false, error: "db_error" }, 200);
      }

      // This used to require more than one Glory week and then `.slice(1)`,
      // discarding the OLDEST one. Measured across production: 658 of the
      // 1,686 players with any Glory have exactly one week, so their best was
      // 0 and they earned no Glory badge at all -- including one holding
      // 369,393,189, which is seven times the top badge threshold. A further
      // 287 had their best week silently dropped for being their first.
      // Nothing documented why, and nothing in the badge catalogue implies it.
      const gloryBest = (gloryRows ?? [])
        .reduce((m: number, r: any) => Math.max(m, Number(r.score) || 0), 0);

      return json({
        ok: true,
        role: full.role || "R1",
        created_at: full.created_at,
        overall_power: full.overall_power || 0,
        attended: attended,
        glory_best: gloryBest
      });
    }

    if (action === "get-weekly-challenges") {
      const res = await getPlayerChallenges(admin, uid, identity.guild);
      if (!res.ok) {
        logger.error("Failed to fetch weekly challenges", res.error, { uid });
        return json(res, 200);
      }
      return json(res);
    }

    if (action === "get-personal-kpis") {
      const member = await getPlayer(admin, uid, identity.guild);
      const targetGuild = member?.guild || identity.guild;

      // gm_personal_kpis is still called: it carries the density, combativity
      // and residual-power indices the Military Force card reads. Its
      // participation figures are ignored in favour of gm_player_stats, which
      // is the same computation the admin Stats page performs -- the two used
      // to differ by 16 points on the same guild.
      //
      // gm_player_stats returns NO per-member row for anyone else and computes
      // no rank, so a player cannot read a peer's attendance through it. The
      // comparison offered is against the guild, not against other members.
      const [rpcRes, statsRes, guildAverages] = await Promise.all([
        admin.rpc("gm_personal_kpis", { p_uid: uid }),
        (targetGuild && member?.pseudo)
          ? admin.rpc("gm_player_stats", { p_guild: targetGuild, p_pseudo: member.pseudo, p_weeks: 4 })
          : Promise.resolve({ data: null, error: null }),
        targetGuild ? getGuildAverages(admin, targetGuild) : Promise.resolve(null)
      ]);
      if (rpcRes.error) {
        logger.error("DB error executing gm_personal_kpis", rpcRes.error, { uid });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data) as Record<string, any> | null;
      if (!row || !row.ok) return json({ ok: false, error: "kpis_failed" }, 200);

      if (statsRes.error) {
        // Not fatal: the rest of the card still renders. Logged so a silent
        // degradation is visible, which is the lesson of the week selector.
        logger.warn("gm_player_stats failed; reliability will be absent", { uid, error: statsRes.error.message });
      }
      const stats = (statsRes.data || null) as Record<string, any> | null;

      return json({
        ...row,
        guild_averages: guildAverages,
        reliability: (stats && stats.ok) ? {
          weeks: stats.weeks,
          player: stats.player,
          guild_totals: stats.guild_totals
        } : null,
        glory_history: (stats && stats.ok) ? stats.glory : null
      });
    }

    if (action === "update-timezone") {
      const offset = Number(payload?.offset);
      const timezone = payload?.timezone ? String(payload.timezone).trim() : null;
      const res = await updatePlayerTimezone(admin, uid, identity.guild, offset, timezone);
      if (!res.ok) {
        const status = res.error === "invalid_offset" ? 400 : 200;
        logger.error("Failed to update player timezone", res.error, { uid, offset, timezone });
        return json(res, status);
      }
      return json(res);
    }

    if (action === "confirm-discord-link") {
      // Never trust a self-typed Discord user id: the code was generated
      // by the /link Discord command and shown only to that Discord user;
      // confirming it here (from an already-authenticated web session) is
      // what actually proves ownership, not the code by itself.
      const code = (payload?.code ?? "").toString().trim().toUpperCase();
      if (!code) return json({ ok: false, error: "missing_code" }, 400);

      const { data: linkCode } = await admin
        .from("discord_link_codes")
        .select("code, discord_user_id, discord_username, expires_at")
        .eq("code", code)
        .maybeSingle();

      if (!linkCode) return json({ ok: false, error: "invalid_code" }, 200);
      if (new Date(linkCode.expires_at).getTime() < Date.now()) {
        await admin.from("discord_link_codes").delete().eq("code", code);
        return json({ ok: false, error: "code_expired" }, 200);
      }

      const { error: insertErr } = await admin
        .from("discord_account_links")
        .insert({ discord_user_id: linkCode.discord_user_id, account_id: identity.accountId });

      if (insertErr) {
        if (insertErr.code === "23505") {
          // Either this Discord account or this FGF account is already linked.
          return json({ ok: false, error: "already_linked" }, 200);
        }
        logger.error("Failed to write discord_account_links", insertErr, { accountId: identity.accountId });
        return json({ ok: false, error: "server_error" }, 500);
      }

      await admin.from("discord_link_codes").delete().eq("code", code);

      logger.info("Discord account linked", { accountId: identity.accountId, discordUserId: linkCode.discord_user_id });
      return json({ ok: true, discord_username: linkCode.discord_username || null });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (unhandledErr) {
    logger.error("Unhandled member-portal error", unhandledErr);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function") {
  (Deno as any).serve(handleRequest);
}
