import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const MAX_ALLOWED_EVENT_SCORE = 500_000_000;

function parseSafeScore(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const num = typeof val === "number" ? val : parseInt(String(val), 10);
  if (isNaN(num) || num < 0) return null;
  return Math.min(Math.round(num), MAX_ALLOWED_EVENT_SCORE);
}

/**
 * Resolve the authenticated player's identity from their account.
 */
async function getIdentity(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<{ uid: string | null; pseudo: string | null; guild: string | null } | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return null;

  const jwt = match[1].trim();
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anon.auth.getUser(jwt);
  if (error || !user) return null;

  const { data: accs } = await admin
    .from("accounts")
    .select("uid, status, guild")
    .eq("auth_user_id", user.id)
    .limit(1);

  const acc = accs?.[0] ?? null;

  if (!acc || acc.status !== "active" || !acc.uid) return null;

  return { uid: acc.uid, pseudo: null, guild: acc.guild ?? null };
}

async function getPlayer(admin: ReturnType<typeof createClient>, uid: string) {
  const { data, error } = await admin
    .from("guild_members")
    .select("pseudo, guild, overall_power, timezone_offset, power_updated_at")
    .eq("uid", uid)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0];
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

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

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
    const member = await getPlayer(admin, uid);
    if (!member) {
      return json({ ok: false, error: "player_not_found" }, 200);
    }

    const { data: activeSessions, error: sErr } = await admin
      .from("event_status")
      .select("event_name, session_id, start_at")
      .eq("guild", member.guild)
      .eq("is_active", true);

    if (sErr) {
      logger.error("DB error fetching active sessions", sErr, { guild: member.guild });
      return json({ ok: false, error: "db_error", message: sErr.message }, 200);
    }

    const week = getWeekStartIso(new Date());
    const { data: gloryRows, error: gErr } = await admin
      .from("event_participants")
      .select("score")
      .eq("guild", member.guild)
      .eq("event_name", "Glory")
      .eq("week_start", week)
      .eq("pseudo", member.pseudo)
      .limit(1);
    if (gErr) return json({ ok: false, error: "db_error", message: gErr.message }, 200);
    const gloryRow = gloryRows?.[0] ?? null;
    const glory = gloryRow?.score != null ? gloryRow.score : null;

    if (!activeSessions || activeSessions.length === 0) {
      return json({ ok: true, pseudo: member.pseudo, guild: member.guild, overall_power: member.overall_power, timezone_offset: member.timezone_offset ?? null, glory, sessions: [] });
    }

    const sessionIds = activeSessions.map(s => s.session_id);
    const { data: participants, error: pErr } = await admin
      .from("event_participants")
      .select("*")
      .eq("guild", member.guild)
      .eq("pseudo", member.pseudo)
      .in("session_id", sessionIds);

    if (pErr) return json({ ok: false, error: "db_error", message: pErr.message }, 200);

    const sessions = activeSessions.map(sess => {
      const part = (participants || []).find(p => p.session_id === sess.session_id);
      return {
        event_name: sess.event_name,
        session_id: sess.session_id,
        start_at: sess.start_at,
        current_data: part || null
      };
    });

    return json({ ok: true, pseudo: member.pseudo, guild: member.guild, overall_power: member.overall_power, timezone_offset: member.timezone_offset ?? null, glory, sessions });
  }

  if (action === "submit-scores") {
    const eventName = (payload?.event_name ?? "").toString().trim();
    const sessionId = (payload?.session_id ?? "").toString().trim();

    if (!eventName || !sessionId) {
      return json({ ok: false, error: "missing_parameters" }, 400);
    }

    const member = await getPlayer(admin, uid);
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

    // FIX (SEV-05): Strict defensive parsing and bounding on numerical scores
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
    if (payload.excused !== undefined) {
      update.excused = !!payload.excused;
    }
    if (payload.appointed !== undefined) {
      update.appointed = !!payload.appointed;
    }

    const { error: uErr } = await admin
      .from("event_participants")
      .update(update)
      .eq("guild", member.guild)
      .eq("event_name", eventName)
      .eq("session_id", sessionId)
      .eq("pseudo", member.pseudo);

    if (uErr) {
      logger.error("Failed to update participant score", uErr, { eventName, sessionId });
      return json({ ok: false, error: "update_failed", message: uErr.message }, 200);
    }

    logger.info("Player submitted event scores", { pseudo: member.pseudo, eventName, sessionId });
    return json({ ok: true });
  }

  if (action === "update-power") {
    const rawPower = parseInt(payload?.power) || 0;
    const MAX_POWER = 100_000_000;
    const power = Math.min(Math.max(0, rawPower), MAX_POWER);

    const { error: uErr } = await admin
      .from("guild_members")
      .update({ overall_power: power, power_updated_at: new Date().toISOString() })
      .eq("uid", uid);

    if (uErr) {
      logger.error("Failed to update player power", uErr, { uid, power });
      return json({ ok: false, error: "update_failed", message: uErr.message }, 200);
    }

    logger.info("Player updated power", { uid, power });
    return json({ ok: true });
  }

  if (action === "update-glory") {
    const rawGlory = parseSafeScore(payload?.glory);
    if (rawGlory === null) {
      return json({ ok: false, error: "invalid_glory" }, 400);
    }

    const member = await getPlayer(admin, uid);
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
      return json({ ok: false, error: "update_failed", message: rErr.message }, 200);
    }
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
    if (!row || !row.ok) return json({ ok: false, error: row?.error || "save_failed" }, 200);

    logger.info("Player updated weekly glory", { pseudo: member.pseudo, week, glory: rawGlory });
    return json({ ok: true, week, glory: rawGlory });
  }

  if (action === "get-transfer-guilds") {
    const member = await getPlayer(admin, uid);
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
      return json({ ok: false, error: "db_error: " + guildsErr.message }, 200);
    }

    return json({ ok: true, guilds: guilds });
  }

  if (action === "submit-transfer-request") {
    const targetGuild = (payload?.targetGuild ?? "").toString().trim();
    if (!targetGuild) return json({ ok: false, error: "missing_target_guild" }, 400);

    const { data, error } = await admin.rpc("request_guild_transfer", {
      p_uid: uid,
      p_target_guild: targetGuild
    });

    if (error) {
      logger.error("Failed request_guild_transfer", error, { uid, targetGuild });
      return json({ ok: false, error: "rpc_failed: " + error.message, message: error.message }, 200);
    }

    logger.info("Player submitted guild transfer request", { uid, targetGuild });
    return json(data);
  }

  if (action === "get-history") {
    const member = await getPlayer(admin, uid);
    if (!member) return json({ ok: false, error: "player_not_found" }, 200);

    const { data: rows, error: hErr } = await admin
      .from("event_participants")
      .select("event_name, session_id, week_start, participated, score, score_prep, score_pvp, late, excused, sub_present, appointed")
      .eq("guild", member.guild)
      .eq("pseudo", member.pseudo)
      .order("week_start", { ascending: false });

    if (hErr) return json({ ok: false, error: "db_error", message: hErr.message }, 200);

    const byEvent: Record<string, any[]> = {};
    const hasScoreEvent = (name: string): boolean => {
      const n = (name || "").toUpperCase();
      if (n.indexOf("SVS") !== -1 || n.indexOf("GVG") !== -1) return true;
      if (n.indexOf("GLORY") !== -1) return true;
      return false;
    };
    (rows || []).forEach((r: any) => {
      const key = (r.event_name || "Other").toUpperCase();
      if (!byEvent[key]) byEvent[key] = [];
      byEvent[key].push({
        session_id: r.session_id,
        week_start: r.week_start,
        participated: r.participated > 0,
        score: (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0),
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

    return json({ ok: true, events: summary, overall: (rows || []).length });
  }

  if (action === "get-absences") {
    const { data, error } = await admin.rpc("gm_get_player_absences", { p_uid: uid });
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
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

    const member = await getPlayer(admin, uid);
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
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
    if (!row || !row.ok) return json({ ok: false, error: row?.error || "save_failed" }, 200);
    return json({ ok: true });
  }

  if (action === "delete-absence") {
    const absenceId = (payload?.id ?? "").toString().trim();
    if (!absenceId) return json({ ok: false, error: "missing_id" }, 400);

    const { data, error } = await admin.rpc("gm_delete_player_absence", {
      p_id: absenceId,
      p_uid: uid,
    });
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
    if (!row || !row.ok) return json({ ok: false, error: row?.error || "delete_failed" }, 200);
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

    if (cErr) return json({ ok: false, error: "db_error", message: cErr.message }, 200);

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

    if (gErr) return json({ ok: false, error: "db_error", message: gErr.message }, 200);

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
    const member = await getPlayer(admin, uid);
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
    if (pErr) return json({ ok: false, error: "db_error", message: pErr.message }, 200);

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
    if (gwErr) return json({ ok: false, error: "db_error", message: gwErr.message }, 200);
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
    const { data, error } = await admin.rpc("gm_personal_kpis", { p_uid: uid });
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean } | null;
    if (!row || !row.ok) return json({ ok: false, error: "kpis_failed" }, 200);
    return json(row);
  }

  if (action === "update-timezone") {
    const offset = parseInt(payload?.offset, 10);
    if (isNaN(offset) || offset < -12 || offset > 14) {
      return json({ ok: false, error: "invalid_offset" }, 400);
    }

    const { data, error } = await admin.rpc("gm_update_player_timezone", {
      p_uid: uid,
      p_offset: offset,
    });
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
    if (!row || !row.ok) return json({ ok: false, error: row?.error || "update_failed" }, 200);
    return json({ ok: true });
  }

  if (action === "get-push-prefs") {
    const { data, error } = await admin.rpc("gm_get_push_prefs", { p_uid: uid });
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
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
    const { data, error } = await admin.rpc("gm_set_push_prefs", {
      p_uid: uid,
      p_event_types: types,
    });
    if (error) return json({ ok: false, error: "db_error", message: error.message }, 200);
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
    if (!row || !row.ok) return json({ ok: false, error: row?.error || "update_failed" }, 200);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
