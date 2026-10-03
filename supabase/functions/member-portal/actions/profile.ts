/**
 * member-portal actions: the player's own figures: power, the military
 * metrics, weekly Glory, time zone.
 */

import { getPlayer } from "../../_shared/member-lookup.ts";
import { MAX_ALLOWED_POWER, logPlayerAction, updatePlayerPower, updatePlayerGlory, updatePlayerTimezone } from "../../_shared/player-actions.ts";
import { type PortalContext } from "../context.ts";

/** `update-power` */
export async function updatePower(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
  const res = await updatePlayerPower(admin, uid, identity.guild, payload?.power);
  if (!res.ok) {
    const status = res.error === "invalid_power" ? 400 : 200;
    logger.error("Failed to update player power", res.error, { uid });
    return json(res, status);
  }
  logger.info("Player updated power", { uid, power: res.power });
  return json(res);
}

/** `update-metrics` */
export async function updateMetrics(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
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

  // The RPC reports refusals in its rows, not as a transport error.
  const metricsRow = (Array.isArray(rpcRes) ? rpcRes[0] : rpcRes) as { ok?: boolean } | null;
  if (rpcErr || (metricsRow && metricsRow.ok === false)) {
    logger.error("Failed to update player metrics via rpc", rpcErr, { uid, pseudo: member.pseudo });
    return json({ ok: false, error: "update_failed" }, 200);
  }

  // A Glory entered here used to stop at the profile: no Glory Tracker row
  // for the week, and the "Submit your Glory score" challenge never ticked.
  // A CHANGED value is filed for the current week through the same path as
  // `/update-stats glory:`; an unchanged one is not, or re-saving the form
  // would record last week's Glory as this week's.
  let gloryWeek: string | null = null;
  if (payload?.glory_score !== undefined && gloryScore !== (Number(member.glory_score) || 0)) {
    const g = await updatePlayerGlory(admin, uid, identity.guild, gloryScore);
    if (g.ok) gloryWeek = g.week ?? null;
    else logger.error("Failed to file portal Glory for the week", g.error, { uid, pseudo: member.pseudo });
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
    glory_week: gloryWeek,
  });
}

/** `get-metrics-history` */
export async function getMetricsHistory(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, payload } = ctx;
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

/** `update-glory` */
export async function updateGlory(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
  const res = await updatePlayerGlory(admin, uid, identity.guild, payload?.glory);
  if (!res.ok) {
    const status = res.error === "invalid_glory" ? 400 : (res.error === "player_not_found" ? 400 : 200);
    logger.error("Failed to update player glory", res.error, { uid });
    return json(res, status);
  }
  logger.info("Player updated weekly glory", { uid, week: res.week, glory: res.glory });
  return json(res);
}

/** `update-timezone` */
export async function updateTimezone(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
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
