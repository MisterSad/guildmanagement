/**
 * member-portal actions: asking to move to another guild of the same server
 * (or of an open migration group).
 */

import { getPlayer } from "../../_shared/member-lookup.ts";
import { logPlayerAction } from "../../_shared/player-actions.ts";
import { type PortalContext } from "../context.ts";

/** `get-transfer-guilds` */
export async function getTransferGuilds(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity } = ctx;
  const member = await getPlayer(admin, uid, identity.guild);
  if (!member) return json({ ok: false, error: "player_not_found" }, 200);

  // Same server, or any server sharing a currently-open cross-server
  // migration group with it — mirrors the admin "Transfer Member"
  // dialog (gm_list_transfer_eligible_guilds), so a player is never
  // offered a target the transfer RPC would reject.
  const { data: guilds, error: guildsErr } = await admin.rpc("gm_list_transfer_eligible_guilds", {
    p_guild: member.guild,
  });

  if (guildsErr) {
    logger.error("Failed to fetch transfer guilds", guildsErr);
    return json({ ok: false, error: "db_error" }, 200);
  }

  return json({ ok: true, guilds: guilds ?? [] });
}

/** `submit-transfer-request` */
export async function submitTransferRequest(ctx: PortalContext): Promise<Response> {
  const { admin, logger, json, uid, identity, payload } = ctx;
  const targetGuild = (payload?.targetGuild ?? "").toString().trim();
  if (!targetGuild) return json({ ok: false, error: "missing_target_guild" }, 400);

  const member = await getPlayer(admin, uid, identity.guild);

  const { data, error } = await admin.rpc("request_guild_transfer", {
    p_uid: uid,
    p_target_guild: targetGuild,
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
      result: data,
    },
  });

  logger.info("Player submitted guild transfer request", { uid, targetGuild });
  return json(data);
}
