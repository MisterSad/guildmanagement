/**
 * supabase/functions/auth-discord/actions/onboard.ts
 *
 * `onboard`: joining a guild by code, or creating one (phase D4).
 */

import { type EdgeLogger } from "../../_shared/logger.ts";
import { establishShadowSession } from "../../_shared/shadow-session.ts";
import { postChannelMessage, resolveAuditChannelId } from "../../_shared/discord-verification.ts";
import { anonClient } from "../../_shared/clients.ts";
import { OnboardSchema } from "../config.ts";
import { makeJson } from "../http.ts";
import { consumeTicket, failContinuation, throttled } from "../tickets.ts";

// ── POST { action: "onboard", mode, ticket, ... } — phase D4 ───────────────
//
// The two ways in for someone with no account: redeem a guild's join code, or
// create a guild. Both spend the continuation ticket, so a join code or a free
// tag is never enough on its own.
//
// Every guardrail is enforced in SQL, not here. The Discord account-age check
// in particular is recomputed from the snowflake inside
// `gm_discord_create_guild` -- a value this function computed would be a value
// a stale deploy could get wrong.
export async function handleOnboard(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = OnboardSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "onboard")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);

  const username = consumed.discordUsername ?? "";
  let row: any;

  if (parsed.data.mode === "join") {
    const { data, error } = await admin.rpc("gm_discord_join_guild", {
      p_discord_user_id: consumed.discordUserId,
      p_discord_username: username,
      p_join_code: parsed.data.join_code,
      p_uid: parsed.data.uid,
    });
    if (error) {
      logger.error("Join-by-code failed", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    row = Array.isArray(data) ? data[0] : data;
  } else {
    const { data, error } = await admin.rpc("gm_discord_create_guild", {
      p_discord_user_id: consumed.discordUserId,
      p_discord_username: username,
      p_guild_tag: parsed.data.guild_tag,
      p_server_number: parsed.data.server_number,
    });
    if (error) {
      logger.error("Guild creation failed", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    row = Array.isArray(data) ? data[0] : data;
  }

  if (!row || row.ok !== true) {
    logger.warn("Onboarding rejected", { mode: parsed.data.mode, reason: row?.err ?? "unknown" });
    return failContinuation(json, admin, logger, consumed, row?.err || "onboarding_failed");
  }

  const accountId = row.account_id as string;
  const role = (row.role as string) || "member";
  logger.setContext({ userId: accountId });

  // A joined member lands in 'pending' and cannot sign in until an admin
  // approves -- the same rule password self-registration has always had.
  // Report that plainly instead of minting a session that would be refused.
  if (row.status === "pending") {
    logger.info("Player registered through Discord, awaiting approval", { accountId, guild: row.guild });
    await announceJoinRequest(admin, logger, row.guild as string, accountId,
      parsed.data.mode === "join" ? parsed.data.uid : "");
    return json({
      ok: true,
      state: "pending_approval",
      id: accountId,
      guild: row.guild,
    });
  }

  const anon = anonClient();
  const shadow = await establishShadowSession(admin, anon, accountId, role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("Onboarded through Discord", { mode: parsed.data.mode, accountId, role, guild: row.guild });

  return json({
    ok: true,
    state: "session",
    created: parsed.data.mode === "create",
    role,
    id: accountId,
    guild: row.guild,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}

/**
 * Tells a guild's admins that someone is waiting for them. Best-effort: the
 * pending account is the authoritative record, and a missing channel or a
 * Discord outage must not turn a successful request into an error.
 */
export async function announceJoinRequest(
  admin: any,
  logger: EdgeLogger,
  guild: string,
  accountId: string,
  uid: string,
): Promise<void> {
  if (!guild) return;
  try {
    const channelId = await resolveAuditChannelId(admin, guild);
    if (!channelId) {
      logger.info("No Discord audit channel configured for guild", { guild });
      return;
    }
    // Approve / Reject act through discord-bot-interactions, which checks the
    // clicker's LINKED app account with the same canManageAccount() the app
    // uses. A Discord role or permission grants nothing.
    const sent = await postChannelMessage(channelId, {
      content:
        `🆕 **Join request** — \`${accountId}\` (UID \`${uid}\`) asked to join **${guild}** with Discord.` +
        `\nApprove or reject it here, or in Guild Management → Accounts → Pending.`,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: "Approve", custom_id: `gmjoin:approve:${accountId}` },
          { type: 2, style: 4, label: "Reject", custom_id: `gmjoin:reject:${accountId}` },
        ],
      }],
    });
    if (!sent) logger.warn("Join request announcement was not delivered", { guild });
  } catch (err) {
    logger.warn("Join request announcement threw", { guild, err: String(err) });
  }
}
