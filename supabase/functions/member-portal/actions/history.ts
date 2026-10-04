/**
 * member-portal actions: read-only views of the player's record: history,
 * badges, challenges, KPIs.
 */

import { getPlayer } from "../../_shared/member-lookup.ts";
import { eventScoringKey, getPlayerChallenges } from "../../_shared/player-actions.ts";
import { getGuildAverages, type PortalContext } from "../context.ts";

/** `get-history` */
export async function getHistory(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity } = ctx;
  const member = await getPlayer(admin, uid, identity.guild);
  if (!member) return json({ ok: false, error: "player_not_found" }, 200);

  // Guild averages are aggregated in SQL, over the player's own sessions
  // only. Reading the guild's whole history here stopped at PostgREST's
  // 1,000-row cap, and 14 guilds saw averages of 0 (audit PERF-02).
  const [memberRowsRes, sessionStatsRes, guildAverages] = await Promise.all([
    admin
      .from("event_participants")
      .select(
        "event_name, session_id, week_start, participated, score, score_prep, score_pvp, late, excused, sub_present, appointed"
      )
      .eq("guild", member.guild)
      .eq("pseudo", member.pseudo)
      .order("week_start", { ascending: false }),
    admin.rpc("gm_player_session_guild_stats", { p_guild: member.guild, p_pseudo: member.pseudo }),
    getGuildAverages(admin, member.guild),
  ]);

  if (memberRowsRes.error) {
    logger.error("Failed to fetch player history", memberRowsRes.error);
    return json({ ok: false, error: "db_error" }, 200);
  }
  if (sessionStatsRes.error) {
    logger.error("Failed to aggregate guild session stats", sessionStatsRes.error);
    return json({ ok: false, error: "db_error" }, 200);
  }

  const rows = memberRowsRes.data || [];

  const guildSessionStats: Record<string, { totalScore: number; count: number; maxScore: number }> = {};
  (
    (sessionStatsRes.data || []) as Array<{
      session_key: string;
      total_score: number;
      counted: number;
      max_score: number;
    }>
  ).forEach((s) => {
    guildSessionStats[s.session_key] = {
      totalScore: Number(s.total_score) || 0,
      count: Number(s.counted) || 0,
      maxScore: Number(s.max_score) || 0,
    };
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
      appointed: !!r.appointed,
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
      history: list.slice(0, 60),
    };
  });

  return json({ ok: true, events: summary, guild_averages: guildAverages, overall: rows.length });
}

/** `get-badges` */
export async function getBadges(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity } = ctx;
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
  const gloryBest = (gloryRows ?? []).reduce((m: number, r: any) => Math.max(m, Number(r.score) || 0), 0);

  return json({
    ok: true,
    role: full.role || "R1",
    created_at: full.created_at,
    overall_power: full.overall_power || 0,
    attended: attended,
    glory_best: gloryBest,
  });
}

/** `get-weekly-challenges` */
export async function getWeeklyChallenges(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity } = ctx;
  const res = await getPlayerChallenges(admin, uid, identity.guild);
  if (!res.ok) {
    logger.error("Failed to fetch weekly challenges", res.error, { uid });
    return json(res, 200);
  }
  return json(res);
}

/** `get-personal-kpis` */
export async function getPersonalKpis(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity } = ctx;
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
    targetGuild && member?.pseudo
      ? admin.rpc("gm_player_stats", { p_guild: targetGuild, p_pseudo: member.pseudo, p_weeks: 4 })
      : Promise.resolve({ data: null, error: null }),
    targetGuild ? getGuildAverages(admin, targetGuild) : Promise.resolve(null),
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
    reliability:
      stats && stats.ok
        ? {
            weeks: stats.weeks,
            player: stats.player,
            guild_totals: stats.guild_totals,
          }
        : null,
    glory_history: stats && stats.ok ? stats.glory : null,
  });
}
