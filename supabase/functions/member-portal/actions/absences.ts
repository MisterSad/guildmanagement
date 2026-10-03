/**
 * member-portal actions: the player's declared absences.
 */

import { listPlayerAbsences, setPlayerAbsence, deletePlayerAbsence } from "../../_shared/player-actions.ts";
import { type PortalContext } from "../context.ts";

/** `get-absences` */
export async function getAbsences(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid } = ctx;
  const res = await listPlayerAbsences(admin, uid);
  if (!res.ok) {
    logger.error("Failed to list player absences", res.error, { uid });
    return json(res, 200);
  }
  return json(res);
}

/** `set-absence` */
export async function setAbsence(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
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

/** `delete-absence` */
export async function deleteAbsence(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
  const absenceId = (payload?.id ?? "").toString().trim();
  const res = await deletePlayerAbsence(admin, uid, identity.guild, absenceId);
  if (!res.ok) {
    const status = res.error === "missing_id" ? 400 : 200;
    logger.error("Failed to delete player absence", res.error, { uid, absenceId });
    return json(res, status);
  }
  return json(res);
}
