/**
 * supabase/functions/auth-discord/tickets.ts
 *
 * Single-use tickets -- the only thing that crosses from the Discord callback
 * to the app -- and the session minted for an account once a ticket has been
 * spent.
 */

import { type EdgeLogger } from "../_shared/logger.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { establishShadowSession } from "../_shared/shadow-session.ts";
import { randomToken } from "../_shared/discord-oauth.ts";
import { anonClient } from "../_shared/clients.ts";
import { CONTINUATION_TTL_MS, MAX_TICKET_ATTEMPTS, RECOVERABLE_ERRORS, IP_LIMIT } from "./config.ts";
import { makeJson } from "./http.ts";

/** The Discord identity a ticket attests, carried from one ticket to the next. */
export interface TicketIdentity {
  discordUserId: string;
  discordUsername: string | null;
  displayName: string | null;
  attempts: number;
}

/** Mints a single-use ticket for a Discord identity. Returns null on failure. */
export async function issueTicket(
  admin: any,
  identity: TicketIdentity,
  logger: EdgeLogger,
  ttlMs: number = CONTINUATION_TTL_MS
): Promise<string | null> {
  const ticket = randomToken(32);
  const { error } = await admin.from("discord_auth_tickets").insert({
    ticket,
    discord_user_id: identity.discordUserId,
    discord_username: identity.discordUsername,
    display_name: identity.displayName,
    attempts: identity.attempts,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  if (error) {
    logger.error("Failed to persist auth ticket", error);
    return null;
  }
  return ticket;
}

/** Spends a ticket, returning the Discord identity it attested. */
export async function consumeTicket(
  admin: any,
  ticket: string,
  logger: EdgeLogger
): Promise<({ ok: true } & TicketIdentity) | { ok: false; error: string; status: number }> {
  const { data: rows, error } = await admin.rpc("gm_consume_discord_auth_ticket", { p_ticket: ticket });
  if (error) {
    logger.error("Failed to consume auth ticket", error);
    return { ok: false, error: "server_error", status: 500 };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return { ok: false, error: "ticket_invalid", status: 200 };
  return {
    ok: true,
    discordUserId: row.discord_user_id as string,
    discordUsername: row.discord_username ?? null,
    displayName: row.display_name ?? null,
    attempts: Number(row.attempts ?? 0),
  };
}

/**
 * Answers a failed continuation action. On a recoverable mistake, and while
 * the chain has attempts left, it hands back a fresh continuation ticket for
 * the same identity so the person can correct the field without another
 * Discord round trip. `attempts_left` counts the tries the new ticket allows,
 * including itself.
 */
export async function failContinuation(
  json: (body: unknown, status?: number) => Response,
  admin: any,
  logger: EdgeLogger,
  consumed: TicketIdentity,
  error: string,
  status = 200,
): Promise<Response> {
  if (RECOVERABLE_ERRORS.has(error) && consumed.attempts < MAX_TICKET_ATTEMPTS) {
    const ticket = await issueTicket(admin, { ...consumed, attempts: consumed.attempts + 1 }, logger);
    if (ticket) {
      return json({ ok: false, error, ticket, attempts_left: MAX_TICKET_ATTEMPTS - consumed.attempts }, status);
    }
  }
  return json({ ok: false, error }, status);
}

/** Shared IP budget check for every POST action. */
export async function throttled(req: Request, admin: any, logger: EdgeLogger, what: string): Promise<boolean> {
  const ip = extractClientIp(req.headers);
  const t = await checkAndRecordIpAttempt(admin, ip, IP_LIMIT);
  if (!t.allowed) logger.warn("IP rate limit exceeded", { ip, what });
  return !t.allowed;
}

// ── Minting a session for one already-resolved account ─────────────────────
//
// Shared by `redeem` (one linked account) and `choose` (the person picked one
// of several). It re-reads the account and re-checks `status` rather than
// trusting whatever the caller resolved earlier: between listing the choices
// and picking one, an account can be suspended.
export async function mintForAccount(
  req: Request,
  admin: any,
  logger: EdgeLogger,
  accountId: string,
  knownRole?: string,
): Promise<Response> {
  const json = makeJson(req);
  logger.setContext({ userId: accountId });

  const { data: acc, error: aErr } = await admin
    .from("accounts")
    .select("id, role, status")
    .eq("id", accountId)
    .maybeSingle();
  if (aErr) {
    logger.error("Failed to load linked account", aErr, { accountId });
    return json({ ok: false, error: "server_error" }, 500);
  }
  if (!acc || !acc.role) {
    logger.warn("Discord link points at a missing account", { accountId });
    return json({ ok: false, error: "account_not_found" }, 200);
  }
  // Finding M14: status must be enforced, not merely returned.
  if (acc.status !== "active") {
    logger.warn("Suspended or pending account attempted Discord sign-in", { accountId, status: acc.status });
    return json({ ok: false, error: "pending_approval" }, 200);
  }
  if (knownRole && knownRole !== acc.role) {
    logger.warn("Role changed between listing and selection", { accountId, knownRole, actual: acc.role });
  }

  const anon = anonClient();
  const shadow = await establishShadowSession(admin, anon, accountId, acc.role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("User signed in with Discord", { accountId, role: acc.role });

  return json({
    ok: true,
    state: "session",
    role: acc.role,
    id: accountId,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}
