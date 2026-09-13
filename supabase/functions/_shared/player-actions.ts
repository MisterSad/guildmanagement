/**
 * supabase/functions/_shared/player-actions.ts
 *
 * Player self-service business logic, extracted from member-portal (Phase 2
 * of the Discord bot) so discord-bot-interactions can call the exact same
 * validated, audited code path -- not a re-implementation. Every exported
 * function reproduces the original member-portal action's validation,
 * bounds, RPC calls and audit-log entry unchanged; member-portal now calls
 * these instead of inlining the logic, the same way it already called
 * getPlayer() from _shared/member-lookup.ts before this phase.
 *
 * member-portal still imports MAX_ALLOWED_POWER / MAX_ALLOWED_EVENT_SCORE /
 * parseSafeScore / getWeekStartIso / eventScoringKey / logPlayerAction from
 * here for its own actions that aren't moving this phase (submit-scores,
 * update-metrics, get-active-sessions, get-badges, ...) -- single source of
 * truth either way, no duplicate copy left behind.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getPlayer } from "./member-lookup.ts";

export const MAX_ALLOWED_POWER = 5_000_000_000;
export const MAX_ALLOWED_EVENT_SCORE = 9_999_999_999;

export function parseSafeScore(val: unknown): number | null {
  if (val === undefined || val === null || val === "") return null;
  const num = typeof val === "number" ? val : parseInt(String(val).replace(/[^0-9]/g, ""), 10);
  if (isNaN(num) || num < 0) return null;
  return Math.min(Math.round(num), MAX_ALLOWED_EVENT_SCORE);
}

export function getWeekStartIso(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

export function getPrevWeekStartIso(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return getWeekStartIso(d);
}

export function eventScoringKey(eventName: string, sessionId: string | null, weekStart: string | null): string {
  const up = (eventName || "").toUpperCase();
  const ws = weekStart || "";
  if (up.indexOf("ARMS RACE") !== -1) return "Arms Race|" + (sessionId || ws);
  if (up === "SHADOWFRONT") return "Shadowfront|" + ws;
  if (up === "SVS") return "SvS|" + ws;
  if (up === "GVG") return "GvG|" + ws;
  if (up === "DEFEND TRADE ROUTE") return "DTR|" + (sessionId || ws);
  return (eventName || "") + "|" + (sessionId || ws);
}

export interface AuditLogEntry {
  action_type: string;
  pseudo: string;
  uid: string;
  guild: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function logPlayerAction(
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

export async function updatePlayerPower(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null,
  rawPowerInput: unknown
): Promise<{ ok: boolean; error?: string; power?: number }> {
  if (rawPowerInput === undefined || rawPowerInput === null || typeof rawPowerInput === "boolean") {
    return { ok: false, error: "invalid_power" };
  }
  const rawPower = Number(rawPowerInput);
  if (!Number.isFinite(rawPower) || rawPower < 0) {
    return { ok: false, error: "invalid_power" };
  }
  const power = Math.min(Math.floor(rawPower), MAX_ALLOWED_POWER);

  const member = await getPlayer(admin, uid, guildContext);
  if (!member) return { ok: false, error: "player_not_found" };

  const { data: rpcRes, error: rpcErr } = await admin.rpc("gm_upsert_player_metrics", {
    p_guild: member.guild,
    p_pseudo: member.pseudo,
    p_total_power: power,
  });

  if (rpcErr) {
    const { error: uErr } = await admin
      .from("guild_members")
      .update({ overall_power: power, power_updated_at: new Date().toISOString() })
      .eq("guild", member.guild)
      .eq("uid", uid);
    if (uErr) return { ok: false, error: "update_failed" };
  }

  await logPlayerAction(admin, {
    action_type: "power_update",
    pseudo: member.pseudo,
    uid,
    guild: member.guild,
    message: `Updated overall power: ${Number(member.overall_power || 0).toLocaleString()} -> ${Number(power).toLocaleString()}`,
    metadata: { previous_power: member.overall_power, new_power: power, rpc_result: rpcRes },
  });

  return { ok: true, power };
}

export async function updatePlayerGlory(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null,
  rawGloryInput: unknown
): Promise<{ ok: boolean; error?: string; week?: string; glory?: number }> {
  const rawGlory = parseSafeScore(rawGloryInput);
  if (rawGlory === null) return { ok: false, error: "invalid_glory" };

  const member = await getPlayer(admin, uid, guildContext);
  if (!member) return { ok: false, error: "player_not_found" };

  const week = getWeekStartIso(new Date());
  const { data, error: rErr } = await admin.rpc("gm_upsert_player_glory", {
    p_guild: member.guild,
    p_pseudo: member.pseudo,
    p_week_start: week,
    p_glory: rawGlory,
  });
  if (rErr) return { ok: false, error: "update_failed" };
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
  if (!row || !row.ok) return { ok: false, error: row?.error || "save_failed" };

  await logPlayerAction(admin, {
    action_type: "glory_update",
    pseudo: member.pseudo,
    uid,
    guild: member.guild,
    message: `Submitted Glory weekly score for week ${week}: ${Number(rawGlory).toLocaleString()}`,
    metadata: { week_start: week, glory_score: rawGlory, previous_glory: member.glory_score },
  });

  return { ok: true, week, glory: rawGlory };
}

export async function updatePlayerTimezone(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null,
  offset: number
): Promise<{ ok: boolean; error?: string }> {
  if (isNaN(offset) || offset < -12 || offset > 14) return { ok: false, error: "invalid_offset" };

  const member = await getPlayer(admin, uid, guildContext);

  const { data, error } = await admin.rpc("gm_update_player_timezone", { p_uid: uid, p_offset: offset });
  if (error) return { ok: false, error: "db_error" };
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
  if (!row || !row.ok) return { ok: false, error: row?.error || "update_failed" };

  await logPlayerAction(admin, {
    action_type: "timezone_update",
    pseudo: member?.pseudo || uid,
    uid,
    guild: member?.guild || guildContext || "UNKNOWN",
    message: `Updated timezone offset to UTC${offset >= 0 ? "+" : ""}${offset}`,
    metadata: { offset },
  });

  return { ok: true };
}

export interface Challenge {
  id: string;
  label: string;
  icon: string;
  done: boolean;
  progress: number;
  target: number;
}

export async function getPlayerChallenges(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null
): Promise<{
  ok: boolean;
  error?: string;
  week?: string;
  challenges?: Challenge[];
  completed?: number;
  total?: number;
  season?: { level: string; events: number };
}> {
  const member = await getPlayer(admin, uid, guildContext);
  if (!member) return { ok: false, error: "player_not_found" };

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
  if (pErr) return { ok: false, error: "db_error" };

  const attended = new Set<string>();
  const seasonAttended = new Set<string>();
  for (const r of (partRows as any[]) ?? []) {
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
  if (gwErr) return { ok: false, error: "db_error" };
  const gloryDone = (gloryThisWeek ?? []).length > 0;

  const powerDone = !!member.power_updated_at &&
    new Date(member.power_updated_at).getTime() >= new Date(week + "T00:00:00Z").getTime();

  const eventsCount = attended.size;
  const challenges: Challenge[] = [
    { id: "events1", label: "Attend 1 event this week", icon: "ph-calendar-check", done: eventsCount >= 1, progress: Math.min(eventsCount, 1), target: 1 },
    { id: "events3", label: "Attend 3 events this week", icon: "ph-lightning", done: eventsCount >= 3, progress: Math.min(eventsCount, 3), target: 3 },
    { id: "events5", label: "Attend 5 events this week", icon: "ph-star", done: eventsCount >= 5, progress: Math.min(eventsCount, 5), target: 5 },
    { id: "glory", label: "Submit your Glory score", icon: "ph-trophy", done: gloryDone, progress: gloryDone ? 1 : 0, target: 1 },
    { id: "power", label: "Refresh your power", icon: "ph-gauge", done: powerDone, progress: powerDone ? 1 : 0, target: 1 },
  ];

  const seasonScore = seasonAttended.size;
  const level = seasonScore >= 15 ? "Gold" : seasonScore >= 8 ? "Silver" : seasonScore >= 3 ? "Bronze" : "None";

  return {
    ok: true,
    week,
    challenges,
    completed: challenges.filter((c) => c.done).length,
    total: challenges.length,
    season: { level, events: seasonScore },
  };
}

export async function listPlayerAbsences(
  admin: ReturnType<typeof createClient>,
  uid: string
): Promise<{ ok: boolean; error?: string; absences?: any[] }> {
  const { data, error } = await admin.rpc("gm_get_player_absences", { p_uid: uid });
  if (error) return { ok: false, error: "db_error" };
  return { ok: true, absences: data ?? [] };
}

export async function setPlayerAbsence(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null,
  params: { startDate: string; endDate: string; kind: string; note?: string | null; id?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  const { startDate, endDate, kind, note, id } = params;
  if (!startDate || !endDate) return { ok: false, error: "missing_dates" };
  if (kind !== "full" && kind !== "reduced") return { ok: false, error: "invalid_kind" };

  const member = await getPlayer(admin, uid, guildContext);
  if (!member) return { ok: false, error: "player_not_found" };

  const { data, error } = await admin.rpc("gm_upsert_player_absence", {
    p_guild: member.guild,
    p_pseudo: member.pseudo,
    p_uid: uid,
    p_id: id || null,
    p_start_date: startDate,
    p_end_date: endDate,
    p_kind: kind,
    p_note: note || null,
  });
  if (error) return { ok: false, error: "db_error" };
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
  if (!row || !row.ok) return { ok: false, error: row?.error || "save_failed" };

  await logPlayerAction(admin, {
    action_type: "absence_set",
    pseudo: member.pseudo,
    uid,
    guild: member.guild,
    message: `Declared ${kind} absence from ${startDate} to ${endDate}${note ? `: "${note}"` : ""}`,
    metadata: { start_date: startDate, end_date: endDate, kind, note: note || null, absence_id: id || null },
  });

  return { ok: true };
}

export async function deletePlayerAbsence(
  admin: ReturnType<typeof createClient>,
  uid: string,
  guildContext: string | null,
  absenceId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!absenceId) return { ok: false, error: "missing_id" };
  const member = await getPlayer(admin, uid, guildContext);

  const { data, error } = await admin.rpc("gm_delete_player_absence", { p_id: absenceId, p_uid: uid });
  if (error) return { ok: false, error: "db_error" };
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; error?: string } | null;
  if (!row || !row.ok) return { ok: false, error: row?.error || "delete_failed" };

  await logPlayerAction(admin, {
    action_type: "absence_delete",
    pseudo: member?.pseudo || uid,
    uid,
    guild: member?.guild || guildContext || "UNKNOWN",
    message: `Cancelled absence declaration (ID: ${absenceId})`,
    metadata: { absence_id: absenceId },
  });

  return { ok: true };
}
