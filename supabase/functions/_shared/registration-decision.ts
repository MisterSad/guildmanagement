/**
 * supabase/functions/_shared/registration-decision.ts
 *
 * Approving or rejecting a pending player registration -- ONE implementation,
 * used by the app (admin-accounts `approve-registration` / `reject-registration`)
 * and by the Discord buttons on a join request (discord-bot-interactions).
 *
 * Moved here verbatim from admin-accounts on 2026-10-03 so a second entry point
 * could not grow a second, subtly different approval: the authorization check
 * (canManageAccount against the target's guild AND server), the shadow-user
 * provisioning that makes the account able to sign in at all, the session-epoch
 * bump on rejection, and the player's DM. What the caller supplies is only WHO
 * is deciding; how that identity was proven (a JWT in the app, a linked Discord
 * account on a button click) is the caller's job.
 */
import { canManageAccount, isMember, normalizeRole, type CallerCtx, type Role } from "./admin-authz.ts";
import { findUserByEmail } from "./pagination.ts";
import { emailFor, randomSecret } from "./shadow-session.ts";
import { sendDirectMessage } from "./discord-verification.ts";
import type { EdgeLogger } from "./logger.ts";
import type { AdminClient } from "./db.ts";

type Admin = AdminClient;

/**
 * Bumps the account's session_version epoch (M4): increments the accounts row
 * AND re-stamps the GoTrue app_metadata so the next minted/refreshed JWT carries
 * the new version. Call on password reset, role change, or suspension so that
 * tokens issued before the event stop matching gm_session_is_valid().
 */
export async function bumpSessionVersion(
  admin: Admin,
  accountId: string,
  role: string,
  authUserId: string | null
): Promise<number> {
  const { data: cur } = await admin.from("accounts").select("session_version").eq("id", accountId).maybeSingle();
  const next = (((cur as any)?.session_version ?? 0) | 0) + 1;
  await admin.from("accounts").update({ session_version: next }).eq("id", accountId);
  if (authUserId) {
    await admin.auth.admin.updateUserById(authUserId, {
      app_metadata: { app_role: role, account_id: accountId, session_version: next },
    });
    // Re-stamping alone did not revoke anything: a stolen refresh token
    // minted a fresh JWT at the new epoch on its next use (audit SEC-07).
    // Ending the sessions deletes their refresh tokens.
    await admin.rpc("gm_revoke_auth_sessions", { p_auth_user_id: authUserId });
  }
  return next;
}

/** A target account's role, guild and server, the server read from its guild when unset. */
export async function getTargetCtx(
  admin: Admin,
  targetAcc: { role?: string | null; guild?: string | null; server_number?: string | null }
): Promise<{ role: Role | null; guild: string | null; serverNumber: string | null }> {
  let sNum = targetAcc.server_number ?? null;
  if (!sNum && targetAcc.guild) {
    const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetAcc.guild).maybeSingle();
    if ((g as any)?.server_number) {
      sNum = (g as any).server_number;
    }
  }
  return {
    role: normalizeRole(targetAcc.role),
    guild: targetAcc.guild ?? null,
    serverNumber: sNum,
  };
}

/** The Discord identity linked to an account, or null. Never taken from a request. */
export async function linkedDiscordUserId(admin: Admin, accountId: string): Promise<string | null> {
  const { data } = await admin
    .from("discord_account_links")
    .select("discord_user_id")
    .eq("account_id", accountId)
    .maybeSingle();
  return ((data as any)?.discord_user_id as string | undefined) ?? null;
}

/**
 * DMs a player the outcome of their join request, so they are not left
 * refreshing a login page. Best-effort: the approval or rejection has already
 * committed, and a player who blocks DMs simply is not told.
 */
export async function notifyRegistrationOutcome(
  admin: Admin,
  logger: EdgeLogger,
  accountId: string,
  guild: string | null,
  outcome: "approved" | "rejected",
  knownDiscordId?: string | null
): Promise<void> {
  try {
    const discordId = knownDiscordId ?? (await linkedDiscordUserId(admin, accountId));
    if (!discordId) return; // A password-era registration: nobody to message.
    const appUrl = Deno.env.get("APP_DEFAULT_ORIGIN") ?? "";
    const where = guild ? `**${guild}**` : "your guild";
    const content =
      outcome === "approved"
        ? `✅ Your request to join ${where} was approved. Sign in with Discord to open your Player Portal` +
          (appUrl ? `: ${appUrl}` : ".")
        : `Your request to join ${where} was not approved. If you think this is a mistake, ask an officer of your guild.`;
    const sent = await sendDirectMessage(discordId, content);
    logger.info("Registration outcome DM", { accountId, outcome, delivered: sent });
  } catch (err) {
    logger.warn("Registration outcome DM threw", { accountId, err: String(err) });
  }
}

/** Who is deciding. `via` only labels the audit row. */
export interface DecisionActor extends CallerCtx {
  accountId: string | null;
  via: "app" | "discord";
}

export type DecisionResult =
  | { ok: true; id: string; guild: string | null }
  | { ok: false; error: string; status: number; message?: string };

/**
 * Approves or rejects one pending player registration on behalf of `actor`.
 * The authorization is HERE, not in the callers: a caller that forgot it
 * could not approve anyone.
 */
export async function decideRegistration(
  admin: Admin,
  logger: EdgeLogger,
  actor: DecisionActor,
  id: string,
  decision: "approve" | "reject"
): Promise<DecisionResult> {
  const { data: targetAcc } = await admin
    .from("accounts")
    .select("role, guild, server_number, status, id")
    .eq("id", id)
    .maybeSingle();
  if (!targetAcc) return { ok: false, error: "not_found", status: 404 };
  const target = targetAcc as {
    id: string;
    role: string | null;
    guild: string | null;
    server_number: string | null;
    status: string;
  };
  if (target.status !== "pending" || !isMember(target.role)) {
    return { ok: false, error: "not_pending", status: 200 };
  }

  const targetCtx = await getTargetCtx(admin, target);
  if (!canManageAccount(actor, targetCtx)) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  if (decision === "approve") {
    const { data, error } = await admin.rpc("gm_approve_player_account", { p_id: id });
    if (error) {
      logger.error("Failed gm_approve_player_account", error, { id });
      return { ok: false, error: "server_error", status: 500, message: error.message };
    }
    if (!data || (data as any).ok !== true) {
      return { ok: false, error: (data as any)?.error || "approve_failed", status: 200 };
    }

    const email = await emailFor(id);
    const secret = randomSecret();
    const meta = { app_role: "member", account_id: id };
    const { data: created, error: cuErr } = await admin.auth.admin.createUser({
      email,
      password: secret,
      email_confirm: true,
      app_metadata: meta,
    });
    let uid = created?.user?.id;
    if (cuErr || !uid) {
      const ex = await findUserByEmail(admin, email);
      if (!ex) {
        logger.error("Failed to provision shadow user on approval", cuErr, { email, id });
        return { ok: false, error: "provision_failed", status: 500 };
      }
      uid = ex.id;
      await admin.auth.admin.updateUserById(uid, { password: secret, app_metadata: meta });
    }
    const { error: aErr } = await admin.rpc("gm_attach_shadow", { p_id: id, p_auth_user_id: uid, p_secret: secret });
    if (aErr) {
      logger.error("Failed gm_attach_shadow on approval", aErr, { id, uid });
      return { ok: false, error: "server_error", status: 500 };
    }

    logger.info("Player registration approved", { id, guild: target.guild, via: actor.via });
    await auditDecision(admin, actor, target, "approved");
    await notifyRegistrationOutcome(admin, logger, id, target.guild, "approved");
    return { ok: true, id, guild: target.guild };
  }

  // Read BEFORE the rejection: whatever it does to the account, the link that
  // says who to tell must still be there when we look it up.
  const rejectedDiscordId = await linkedDiscordUserId(admin, id);

  const { error } = await admin.rpc("gm_reject_player_account", { p_id: id });
  if (error) {
    logger.error("Failed gm_reject_player_account", error, { id });
    return { ok: false, error: "server_error", status: 500, message: error.message };
  }

  // Suspension: bump the epoch so any session minted while the account was
  // pending stops matching gm_session_is_valid().
  await bumpSessionVersion(admin, id, target.role || "member", null);

  logger.info("Player registration rejected", { id, guild: target.guild, via: actor.via });
  await auditDecision(admin, actor, target, "rejected");
  await notifyRegistrationOutcome(admin, logger, id, target.guild, "rejected", rejectedDiscordId);
  return { ok: true, id, guild: target.guild };
}

/** The ledger row: who decided, for whom, and from where. Best-effort, like every audit insert here. */
async function auditDecision(
  admin: Admin,
  actor: DecisionActor,
  target: { id: string; guild: string | null },
  outcome: "approved" | "rejected"
): Promise<void> {
  try {
    await admin.from("system_audit_logs").insert({
      level: "INFO",
      service: actor.via === "discord" ? "discord-bot-interactions" : "admin-accounts",
      action_type: outcome === "approved" ? "registration_approved" : "registration_rejected",
      guild: target.guild,
      user_identifier: actor.accountId,
      message: `Registration of ${target.id} ${outcome}` + (actor.via === "discord" ? " from Discord" : ""),
      metadata: { target_account: target.id, actor_role: actor.role, via: actor.via },
    });
  } catch {
    /* the decision has committed; the ledger row is best-effort */
  }
}
