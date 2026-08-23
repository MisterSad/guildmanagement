import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

// Bounding constants
const MAX_ALLOWED_POWER = 5_000_000_000;
const MAX_ALLOWED_EVENT_SCORE = 500_000_000;

function parseSafeScore(val: unknown): number | null {
  if (val === undefined || val === null || val === "") return null;
  const num = typeof val === "number" ? val : parseInt(String(val).replace(/[^0-9]/g, ""), 10);
  if (isNaN(num) || num < 0) return null;
  return Math.min(Math.round(num), MAX_ALLOWED_EVENT_SCORE);
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
    .select("id, role, guild, status")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc || acc.status !== "active") return null;

  const accountId = acc.id as string;
  const role = (acc.role || "member") as string;
  const guild = (acc.guild || null) as string | null;

  const { data: shadow } = await admin
    .rpc("gm_get_shadow", { p_id: accountId });

  const row = Array.isArray(shadow) ? shadow[0] : shadow;
  const playerUid = (row?.player_uid || accountId) as string;

  return {
    accountId,
    role,
    guild,
    uid: playerUid,
  };
}

async function getPlayer(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null
): Promise<{ pseudo: string; guild: string; overall_power?: number; power_updated_at?: string; tech_power?: number; champion_power?: number; crew_power?: number; flagship_power?: number; fleet_rating?: number; glory_score?: number; role?: string } | null> {
  let query = admin
    .from("guild_members")
    .select("pseudo, guild, overall_power, power_updated_at, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, role")
    .eq("uid", uid);

  if (guildContext) {
    query = query.eq("guild", guildContext);
  }

  const { data: rows, error } = await query.limit(1);

  if (error || !rows || rows.length === 0) return null;
  return rows[0];
}

async function getGuildAverages(
  admin: ReturnType<typeof createClient>,
  guild: string
): Promise<{ attendance_rate: number; avg_power: number; member_count: number }> {
  try {
    const { data: members } = await admin
      .from("guild_members")
      .select("overall_power")
      .eq("guild", guild);

    const count = members?.length || 0;
    const totalPower = members?.reduce((sum: number, m: any) => sum + (Number(m.overall_power) || 0), 0) || 0;
    const avgPower = count > 0 ? Math.round(totalPower / count) : 0;

    const { data: participants } = await admin
      .from("event_participants")
      .select("participated, sub_present")
      .eq("guild", guild);

    const totalEvents = participants?.length || 0;
    const attendedEvents = participants?.filter((p: any) => p.participated > 0 || p.sub_present).length || 0;
    const attendanceRate = totalEvents > 0 ? Math.round((attendedEvents / totalEvents) * 100) : 0;

    return {
      attendance_rate: attendanceRate,
      avg_power: avgPower,
      member_count: count
    };
  } catch (_) {
    return { attendance_rate: 0, avg_power: 0, member_count: 0 };
  }
}

interface AuditLogEntry {
  action_type: string;
  pseudo: string;
  uid: string;
  guild: string;
  message: string;
  metadata?: Record<string, unknown>;
}

async function logPlayerAction(
  admin: ReturnType<typeof createClient>,
  entry: AuditLogEntry
): Promise<void> {
  try {
    const { data: g } = await admin
      .from("guilds")
      .select("server_number")
      .eq("id", entry.guild)
      .maybeSingle();

    const serverNumber = g?.server_number || null;

    await admin.rpc("gm_log_player_audit", {
      p_action_type: entry.action_type,
      p_pseudo: entry.pseudo,
      p_uid: entry.uid,
      p_guild: entry.guild,
      p_server_number: serverNumber,
      p_message: entry.message,
      p_metadata: entry.metadata || {}
    });
  } catch (_) {
    // Non-blocking logging
  }
}

function getWeekStartIso(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

function getPrevWeekStartIso(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return getWeekStartIso(d);
}

function eventScoringKey(eventName: string, sessionId: string | null, weekStart: string | null): string {
  const up = (eventName || "").toUpperCase();
  const ws = weekStart || "";
  if (up.indexOf("ARMS RACE") !== -1) return "Arms Race|" + (sessionId || ws);
  if (up === "SHADOWFRONT") return "Shadowfront|" + ws;
  if (up === "SVS") return "SvS|" + ws;
  if (up === "GVG") return "GvG|" + ws;
  if (up === "DEFEND TRADE ROUTE") return "DTR|" + (sessionId || ws);
  return (eventName || "") + "|" + (sessionId || ws);
}

Deno.serve(async (req: Request) => {
  const logger = new EdgeLogger("member-portal", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, req);

  try {
    let action = "";
    let payload: any = {};
    try {
      const body = await req.json();
      action = (body?.action ?? "").toString();
      payload = body?.payload ?? {};
    } catch (err) {
      logger.error("Failed to parse request JSON", err);
      return json({ ok: false, error: "bad_request" }, 400);
    }

    if (!action) return json({ ok: false, error: "missing_action" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

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
          (r) => r.event_name === s.event_name && r.session_id === s.session_id
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

      const { data: existingRows } = await admin
        .from("event_participants")
        .select("is_pending")
        .eq("guild", member.guild)
        .eq("event_name", eventName)
        .eq("session_id", sessionId)
        .eq("pseudo", member.pseudo)
        .limit(1);

      const existing = existingRows?.[0] ?? null;

      if (existing && existing.is_pending === false) {
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
      if (payload.score_prep !== undefined) {
        const parsed = parseSafeScore(payload.score_prep);
        if (parsed !== null) update.score_prep = parsed;
      }
      if (payload.score_pvp !== undefined) {
        const parsed = parseSafeScore(payload.score_pvp);
        if (parsed !== null) update.score_pvp = parsed;
      }
      if (payload.late !== undefined) {
        update.late = !!payload.late;
      }
      // Stripped client-supplied excused and appointed (sanction-evasion / attendance credit vectors)

      const { error: uErr } = await admin
        .from("event_participants")
        .update(update)
        .eq("guild", member.guild)
        .eq("event_name", eventName)
        .eq("session_id", sessionId)
        .eq("pseudo", member.pseudo);

      if (uErr) {
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
      if (payload?.power === undefined || payload?.power === null || typeof payload.power === "boolean") {
        return json({ ok: false, error: "invalid_power" }, 400);
      }
      const rawPower = Number(payload.power);
      if (!Number.isFinite(rawPower) || rawPower < 0) {
        return json({ ok: false, error: "invalid_power" }, 400);
      }
      const power = Math.min(Math.floor(rawPower), MAX_ALLOWED_POWER);

      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 200);

      const { data: rpcRes, error: rpcErr } = await admin.rpc("gm_upsert_player_metrics", {
        p_guild: member.guild,
        p_pseudo: member.pseudo,
        p_total_power: power
      });

      if (rpcErr) {
        logger.error("Failed to update player power via rpc", rpcErr, { uid, power });
        const { error: uErr } = await admin
          .from("guild_members")
          .update({ overall_power: power, power_updated_at: new Date().toISOString() })
          .eq("guild", member.guild)
          .eq("uid", uid);
        if (uErr) return json({ ok: false, error: "update_failed" }, 200);
      }

      await logPlayerAction(admin, {
        action_type: "power_update",
        pseudo: member.pseudo,
        uid,
        guild: member.guild,
        message: `Updated overall power: ${Number(member.overall_power || 0).toLocaleString()} -> ${Number(power).toLocaleString()}`,
        metadata: {
          previous_power: member.overall_power,
          new_power: power,
          rpc_result: rpcRes
        }
      });

      logger.info("Player updated power", { uid, pseudo: member.pseudo, power });
      return json({ ok: true, power });
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
      const rawGlory = parseSafeScore(payload?.glory);
      if (rawGlory === null) {
        return json({ ok: false, error: "invalid_glory" }, 400);
      }

      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 400);

      const week = getWeekStartIso(new Date());
      const { data, error: rErr } = await admin.rpc("gm_upsert_player_glory", {
        p_guild: member.guild,
        p_pseudo: member.pseudo,
        p_week_start: week,
        p_glory: rawGlory,
      });
      if (rErr) {
        logger.error("Failed gm_upsert_player_glory", rErr, { week, rawGlory });
        return json({ ok: false, error: "update_failed" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
      if (!row || !row.ok) return json({ ok: false, error: row?.error || "save_failed" }, 200);

      await logPlayerAction(admin, {
        action_type: "glory_update",
        pseudo: member.pseudo,
        uid,
        guild: member.guild,
        message: `Submitted Glory weekly score for week ${week}: ${Number(rawGlory).toLocaleString()}`,
        metadata: {
          week_start: week,
          glory_score: rawGlory,
          previous_glory: member.glory_score
        }
      });

      logger.info("Player updated weekly glory", { pseudo: member.pseudo, week, glory: rawGlory });
      return json({ ok: true, week, glory: rawGlory });
    }

    if (action === "get-transfer-guilds") {
      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 200);

      const { data: sourceGuilds, error: gErr } = await admin
        .from("guilds")
        .select("server_number")
        .eq("id", member.guild)
        .limit(1);

      const sourceGuild = sourceGuilds?.[0] ?? null;

      if (gErr || !sourceGuild || !sourceGuild.server_number) {
        return json({ ok: false, error: "server_not_found" }, 200);
      }

      const { data: guilds, error: guildsErr } = await admin
        .from("guilds")
        .select("id")
        .eq("server_number", sourceGuild.server_number)
        .neq("id", member.guild);

      if (guildsErr) {
        logger.error("Failed to fetch transfer guilds", guildsErr);
        return json({ ok: false, error: "db_error" }, 200);
      }

      return json({ ok: true, guilds: guilds });
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
      const { data, error } = await admin.rpc("gm_get_player_absences", { p_uid: uid });
      if (error) {
        logger.error("Failed gm_get_player_absences", error, { uid });
        return json({ ok: false, error: "db_error" }, 200);
      }
      return json({ ok: true, absences: data ?? [] });
    }

    if (action === "set-absence") {
      const startDate = (payload?.start_date ?? "").toString().trim();
      const endDate = (payload?.end_date ?? "").toString().trim();
      const kind = (payload?.kind ?? "full").toString().trim();
      const note = (payload?.note ?? "").toString().trim();
      const absenceId = payload?.id ? (payload.id).toString().trim() : null;

      if (!startDate || !endDate) return json({ ok: false, error: "missing_dates" }, 400);
      if (kind !== "full" && kind !== "reduced") return json({ ok: false, error: "invalid_kind" }, 400);

      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 400);

      const { data, error } = await admin.rpc("gm_upsert_player_absence", {
        p_guild: member.guild,
        p_pseudo: member.pseudo,
        p_uid: uid,
        p_id: absenceId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_kind: kind,
        p_note: note || null,
      });
      if (error) {
        logger.error("Failed gm_upsert_player_absence", error, { uid, startDate, endDate });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
      if (!row || !row.ok) return json({ ok: false, error: row?.error || "save_failed" }, 200);

      await logPlayerAction(admin, {
        action_type: "absence_set",
        pseudo: member.pseudo,
        uid,
        guild: member.guild,
        message: `Declared ${kind} absence from ${startDate} to ${endDate}${note ? `: "${note}"` : ""}`,
        metadata: {
          start_date: startDate,
          end_date: endDate,
          kind,
          note: note || null,
          absence_id: absenceId
        }
      });

      return json({ ok: true });
    }

    if (action === "delete-absence") {
      const absenceId = (payload?.id ?? "").toString().trim();
      if (!absenceId) return json({ ok: false, error: "missing_id" }, 400);

      const member = await getPlayer(admin, uid, identity.guild);

      const { data, error } = await admin.rpc("gm_delete_player_absence", {
        p_id: absenceId,
        p_uid: uid,
      });
      if (error) {
        logger.error("Failed gm_delete_player_absence", error, { uid, absenceId });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
      if (!row || !row.ok) return json({ ok: false, error: row?.error || "delete_failed" }, 200);

      await logPlayerAction(admin, {
        action_type: "absence_delete",
        pseudo: member?.pseudo || uid,
        uid,
        guild: member?.guild || identity.guild || "UNKNOWN",
        message: `Cancelled absence declaration (ID: ${absenceId})`,
        metadata: {
          absence_id: absenceId
        }
      });

      return json({ ok: true });
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

      let gloryBest = 0;
      if ((gloryRows ?? []).length > 1) {
        gloryBest = (gloryRows ?? [])
          .slice(1)
          .reduce((m: number, r: any) => Math.max(m, Number(r.score) || 0), 0);
      }

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
      const member = await getPlayer(admin, uid, identity.guild);
      if (!member) return json({ ok: false, error: "player_not_found" }, 200);

      const week = getWeekStartIso(new Date());
      const prevWeek = getPrevWeekStartIso(week);
      const prevPrev = getPrevWeekStartIso(prevWeek);
      const prev3 = getPrevWeekStartIso(prevPrev);

      const { data: partRows, error: pErr } = await admin
        .from("event_participants")
        .select("event_name, session_id, week_start")
        .eq("guild", member.guild)
        .eq("pseudo", member.pseudo)
        .neq("event_name", "Glory")
        .or(`participated.gt.0,sub_present.eq.true`);
      if (pErr) {
        logger.error("Failed to fetch challenge participant rows", pErr);
        return json({ ok: false, error: "db_error" }, 200);
      }

      const attended = new Set<string>();
      const seasonAttended = new Set<string>();
      for (const r of partRows ?? []) {
        const key = eventScoringKey(r.event_name, r.session_id, r.week_start);
        if (!key) continue;
        if (r.week_start === week) attended.add(key);
        if (r.week_start >= prev3 && r.week_start <= week) seasonAttended.add(key);
      }

      const { data: gloryThisWeek, error: gwErr } = await admin
        .from("event_participants")
        .select("score")
        .eq("guild", member.guild)
        .eq("pseudo", member.pseudo)
        .eq("event_name", "Glory")
        .eq("week_start", week)
        .gt("score", 0)
        .limit(1);
      if (gwErr) {
        logger.error("Failed to fetch weekly glory", gwErr);
        return json({ ok: false, error: "db_error" }, 200);
      }
      const gloryDone = (gloryThisWeek ?? []).length > 0;

      const powerDone = !!member.power_updated_at &&
        new Date(member.power_updated_at).getTime() >= new Date(week + "T00:00:00Z").getTime();

      const eventsCount = attended.size;
      const challenges = [
        { id: "events1", label: "Attend 1 event this week", icon: "ph-calendar-check", done: eventsCount >= 1, progress: Math.min(eventsCount, 1), target: 1 },
        { id: "events3", label: "Attend 3 events this week", icon: "ph-lightning", done: eventsCount >= 3, progress: Math.min(eventsCount, 3), target: 3 },
        { id: "events5", label: "Attend 5 events this week", icon: "ph-star", done: eventsCount >= 5, progress: Math.min(eventsCount, 5), target: 5 },
        { id: "glory", label: "Submit your Glory score", icon: "ph-trophy", done: gloryDone, progress: gloryDone ? 1 : 0, target: 1 },
        { id: "power", label: "Refresh your power", icon: "ph-gauge", done: powerDone, progress: powerDone ? 1 : 0, target: 1 }
      ];

      const seasonScore = seasonAttended.size;
      const level = seasonScore >= 15 ? "Gold" : seasonScore >= 8 ? "Silver" : seasonScore >= 3 ? "Bronze" : "None";

      return json({
        ok: true,
        week,
        challenges,
        completed: challenges.filter((c) => c.done).length,
        total: challenges.length,
        season: { level, events: seasonScore }
      });
    }

    if (action === "get-personal-kpis") {
      const member = await getPlayer(admin, uid, identity.guild);
      const targetGuild = member?.guild || identity.guild;

      const [rpcRes, guildAverages] = await Promise.all([
        admin.rpc("gm_personal_kpis", { p_uid: uid }),
        targetGuild ? getGuildAverages(admin, targetGuild) : Promise.resolve(null)
      ]);
      if (rpcRes.error) {
        logger.error("DB error executing gm_personal_kpis", rpcRes.error, { uid });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data) as Record<string, any> | null;
      if (!row || !row.ok) return json({ ok: false, error: "kpis_failed" }, 200);
      return json({ ...row, guild_averages: guildAverages });
    }

    if (action === "update-timezone") {
      const offset = parseInt(payload?.offset, 10);
      if (isNaN(offset) || offset < -12 || offset > 14) {
        return json({ ok: false, error: "invalid_offset" }, 400);
      }

      const member = await getPlayer(admin, uid, identity.guild);

      const { data, error } = await admin.rpc("gm_update_player_timezone", {
        p_uid: uid,
        p_offset: offset,
      });
      if (error) {
        logger.error("Failed gm_update_player_timezone", error, { uid, offset });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
      if (!row || !row.ok) return json({ ok: false, error: row?.error || "update_failed" }, 200);

      await logPlayerAction(admin, {
        action_type: "timezone_update",
        pseudo: member?.pseudo || uid,
        uid,
        guild: member?.guild || identity.guild || "UNKNOWN",
        message: `Updated timezone offset to UTC${offset >= 0 ? "+" : ""}${offset}`,
        metadata: {
          offset
        }
      });

      return json({ ok: true });
    }

    if (action === "get-push-prefs") {
      const { data, error } = await admin.rpc("gm_get_push_prefs", { p_uid: uid });
      if (error) {
        logger.error("Failed gm_get_push_prefs", error, { uid });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { event_types?: string[] } | null;
      return json({
        ok: true,
        event_types: row?.event_types ?? ["events", "glory", "challenges"]
      });
    }

    if (action === "set-push-prefs") {
      const types = Array.isArray(payload?.event_types)
        ? payload.event_types.filter((t: unknown) => typeof t === "string")
        : [];
      if (types.length === 0) {
        return json({ ok: false, error: "invalid_event_types" }, 400);
      }

      const member = await getPlayer(admin, uid, identity.guild);

      const { data, error } = await admin.rpc("gm_set_push_prefs", {
        p_uid: uid,
        p_event_types: types,
      });
      if (error) {
        logger.error("Failed gm_set_push_prefs", error, { uid, types });
        return json({ ok: false, error: "db_error" }, 200);
      }
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
      if (!row || !row.ok) return json({ ok: false, error: row?.error || "update_failed" }, 200);

      await logPlayerAction(admin, {
        action_type: "push_prefs",
        pseudo: member?.pseudo || uid,
        uid,
        guild: member?.guild || identity.guild || "UNKNOWN",
        message: `Updated push notification preferences: [${types.join(", ")}]`,
        metadata: {
          event_types: types
        }
      });

      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (unhandledErr) {
    logger.error("Unhandled member-portal error", unhandledErr);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
