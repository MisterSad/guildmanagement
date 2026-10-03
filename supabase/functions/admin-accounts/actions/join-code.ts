/**
 * admin-accounts actions: the guild's join code.
 */

import { isGuildAdmin, isGuildInScope, isServerAdmin } from "../../_shared/admin-authz.ts";
import { SetJoinCodeSchema, GetJoinCodeSchema } from "../schemas.ts";
import type { AdminContext } from "../context.ts";

/** `set-join-code` */
export async function setJoinCode(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, callerGuild, body } = ctx;
  const setJoinParsed = SetJoinCodeSchema.safeParse(body);
  if (!setJoinParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
  const guild = setJoinParsed.data.guild ?? null;
  const code = setJoinParsed.data.code;

  let targetGuild = guild;
  if (isGuildAdmin(info.role)) {
    if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
    targetGuild = callerGuild;
  } else if (!targetGuild) {
    return json({ ok: false, error: "missing_fields" }, 400);
  } else if (isServerAdmin(info.role)) {
    const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
    if (!isGuildInScope(info, targetGuild, g?.server_number ?? null)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
  }

  const { data, error } = await admin.rpc("gm_set_join_code", {
    p_guild: targetGuild,
    p_code: code,
  });
  if (error) {
    logger.error("Failed to set join code", error, { targetGuild });
    return json({ ok: false, error: "server_error", message: error.message }, 500);
  }
  return json(data);
}

/** `get-join-code` */
export async function getJoinCode(ctx: AdminContext): Promise<Response> {
  const { admin, logger, json, info, callerGuild, body } = ctx;
  const getJoinParsed = GetJoinCodeSchema.safeParse(body);
  if (!getJoinParsed.success) return json({ ok: false, error: "missing_fields" }, 400);
  const guild = getJoinParsed.data.guild ?? null;
  let targetGuild = guild;
  if (isGuildAdmin(info.role)) {
    if (!callerGuild) return json({ ok: false, error: "forbidden" }, 403);
    targetGuild = callerGuild;
  } else if (!targetGuild) {
    return json({ ok: false, error: "missing_fields" }, 400);
  } else if (isServerAdmin(info.role)) {
    const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetGuild).maybeSingle();
    if (!isGuildInScope(info, targetGuild, g?.server_number ?? null)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
  }

  const { data, error } = await admin.rpc("gm_get_join_code", {
    p_guild: targetGuild,
  });
  if (error) {
    logger.error("Failed to get join code", error, { targetGuild });
    return json({ ok: false, error: "server_error", message: error.message }, 500);
  }
  return json(data);
}
