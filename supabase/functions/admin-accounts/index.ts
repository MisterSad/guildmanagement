/**
 * supabase/functions/admin-accounts/index.ts
 *
 * Account administration for the three admin roles: one POST endpoint,
 * `{ action, ... }`. This file rate-limits by IP, resolves the caller
 * (_shared/auth.ts) and refuses anyone who is not an administrator, then
 * routes to the action. Each action validates its own body (schemas.ts) and
 * makes its own scope decision through _shared/admin-authz.ts.
 *
 *   actions/accounts.ts        list, create, update-role, delete, update-guild, reset-password
 *   actions/discord.ts         discord-unlink, issue-admin-invite
 *   actions/join-code.ts       set-join-code, get-join-code
 *   actions/registrations.ts   approve-registration, reject-registration
 *   actions/guild-requests.ts  the self-service guild creation queue
 *   actions/recovery-codes.ts  the super_admin's recovery codes
 */

import { EdgeLogger } from "../_shared/logger.ts";
import { isAdminRole } from "../_shared/admin-authz.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { resolveCaller } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";
import type { AdminContext } from "./context.ts";
import { backupCodes } from "./actions/recovery-codes.ts";
import { list, create, updateRole, deleteAccount, updateGuild, resetPassword } from "./actions/accounts.ts";
import { discordUnlink, issueAdminInvite } from "./actions/discord.ts";
import { setJoinCode, getJoinCode } from "./actions/join-code.ts";
import { decideRegistrationAction } from "./actions/registrations.ts";
import {
  listGuildRequests,
  clearResolvedGuildRequests,
  approveGuildRequest,
  rejectGuildRequest,
} from "./actions/guild-requests.ts";

const ACTIONS: Record<string, (ctx: AdminContext) => Promise<Response>> = {
  "backup-codes-status": backupCodes,
  "backup-codes-regenerate": backupCodes,
  "list": list,
  "create": create,
  "update-role": updateRole,
  "delete": deleteAccount,
  "update-guild": updateGuild,
  "reset-password": resetPassword,
  "discord-unlink": discordUnlink,
  "issue-admin-invite": issueAdminInvite,
  "set-join-code": setJoinCode,
  "get-join-code": getJoinCode,
  "approve-registration": decideRegistrationAction,
  "reject-registration": decideRegistrationAction,
  "list-guild-requests": listGuildRequests,
  "clear-resolved-guild-requests": clearResolvedGuildRequests,
  "approve-guild-request": approveGuildRequest,
  "reject-guild-request": rejectGuildRequest,
};

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

export async function handler(req: Request): Promise<Response> {
  const json = makeJson(req);
  const logger = new EdgeLogger("admin-accounts", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = serviceClient();

  const clientIp = extractClientIp(req.headers);
  const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 60, windowMs: 300_000 });
  if (!throttle.allowed) {
    logger.warn("IP rate limit exceeded on admin-accounts", { ip: clientIp });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  // One resolver for every function (_shared/auth.ts): JWT, active account,
  // session epoch, normalised role, server.
  const info = await resolveCaller(req, admin);

  if (!info.role || !isAdminRole(info.role)) {
    logger.warn("Unauthorized admin-accounts call", { role: info.role });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  logger.setContext({ tenantId: info.guild, userId: info.accountId });
  const callerGuild = info.guild;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (err) {
    logger.error("Failed to parse request JSON", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const action = (body?.action ?? "").toString();

  const run = ACTIONS[action];
  if (run) return await run({ admin, logger, json, info, callerGuild, body, action });

  return json({ ok: false, error: "unknown_action" }, 400);
}

serveUnlessTest(handler);
