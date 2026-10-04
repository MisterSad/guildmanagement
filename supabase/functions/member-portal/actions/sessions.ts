/**
 * member-portal actions: the events a player is in right now, and the scores
 * they submit for them.
 */

import { getPlayer } from "../../_shared/member-lookup.ts";
import {
  parseSafeScore,
  participantEventName,
  isOfficerRecorded,
  warSubmissionRows,
  getWeekStartIso,
  logPlayerAction,
} from "../../_shared/player-actions.ts";
import { getGuildAverages, type PortalContext } from "../context.ts";

/** `get-active-sessions` */
export async function getActiveSessions(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity } = ctx;
  const member = await getPlayer(admin, uid, identity.guild);
  if (!member) {
    return json({ ok: false, error: "player_not_found" }, 200);
  }

  const [activeSessionsRes, gloryRowsRes, guildAverages, discordLinkRes] = await Promise.all([
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
    getGuildAverages(admin, member.guild),
    // Only whether a link exists, for the My Info card: never the Discord id.
    admin
      .from("discord_account_links")
      .select("account_id", { count: "exact", head: true })
      .eq("account_id", identity.accountId),
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
      .select(
        "event_name, session_id, score, score_prep, score_pvp, participated, is_pending, late, excused, sub_present"
      )
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
      sub_present: p ? p.sub_present : false,
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
    guild_averages: guildAverages,
    discord_linked: !discordLinkRes.error && (discordLinkRes.count ?? 0) > 0,
  });
}

/** `submit-scores` */
export async function submitScores(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
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
    is_pending: true,
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
      previous_is_pending: existing?.is_pending,
    },
  });

  logger.info("Player submitted event scores", { pseudo: member.pseudo, eventName, sessionId });
  return json({ ok: true });
}
