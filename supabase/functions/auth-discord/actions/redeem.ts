/**
 * supabase/functions/auth-discord/actions/redeem.ts
 *
 * `redeem` spends the callback ticket; `choose` picks one of several linked
 * accounts.
 */

import { type EdgeLogger } from "../../_shared/logger.ts";
import { RedeemSchema, ChooseSchema } from "../config.ts";
import { makeJson } from "../http.ts";
import { type TicketIdentity, issueTicket, consumeTicket, throttled, mintForAccount } from "../tickets.ts";

// ── POST { action: "choose", ticket, account_id } ──────────────────────────
//
// Spends the continuation ticket issued by a `choose` response. The account id
// is verified against the LINKS for that ticket's Discord identity, so this is
// not an endpoint that mints a session for any account id you name -- the
// person must have just proved control of a Discord identity that holds it.
export async function handleChoose(req: Request, body: any, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = ChooseSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "choose")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);

  const { data: link, error: lErr } = await admin
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", consumed.discordUserId)
    .eq("account_id", parsed.data.account_id)
    .maybeSingle();
  if (lErr) {
    logger.error("Failed to verify the chosen link", lErr, { discordUserId: consumed.discordUserId });
    return json({ ok: false, error: "server_error" }, 500);
  }
  if (!link) {
    // Either a forged account id or a link removed mid-flight. The same answer
    // for both: naming an account that is not yours must not confirm it exists.
    logger.warn("Chosen account is not linked to this Discord identity", {
      discordUserId: consumed.discordUserId, requested: parsed.data.account_id,
    });
    return json({ ok: false, error: "account_not_linked" }, 403);
  }

  return await mintForAccount(req, admin, logger, link.account_id as string);
}

// ── POST { action: "redeem", ticket } ───────────────────────────────────────
export async function handleRedeem(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = RedeemSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "redeem")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);
  const discordUserId = consumed.discordUserId;
  // A fresh authorization: the retry budget starts over.
  const identity: TicketIdentity = { ...consumed, attempts: 0 };

  // Several links are legitimate since 2026-09-27: one person who is both an
  // administrator and a player holds both accounts. `.maybeSingle()` would
  // ERROR on that, not pick one, so this reads them all.
  const { data: links, error: lErr } = await admin
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId);
  if (lErr) {
    logger.error("Failed to resolve Discord link", lErr, { discordUserId });
    return json({ ok: false, error: "server_error" }, 500);
  }
  const link = links && links.length === 1 ? links[0] : null;

  // No link yet. The original ticket has just been spent, so a CONTINUATION
  // ticket is issued for the same Discord identity: without it the caller
  // would have to restart the whole Discord round trip merely to present a
  // relink code. It is single-use and short-lived exactly like the first.
  //
  // D6 uses this to accept a relink code; D3 (claim) and D4 (onboarding) hang
  // off the same branch and the same continuation ticket.
  // More than one account on this identity: let the person say which. Only
  // ACTIVE accounts are offered, so a suspended one is neither listed nor
  // selectable, and a suspended account does not reveal that it exists.
  if (links && links.length > 1) {
    const ids = links.map((l: any) => l.account_id as string);
    const { data: accs, error: accErr } = await admin
      .from("accounts")
      .select("id, role, guild, status")
      .in("id", ids);
    if (accErr) {
      logger.error("Failed to load linked accounts", accErr, { discordUserId });
      return json({ ok: false, error: "server_error" }, 500);
    }
    const choices = (accs ?? []).filter((a: any) => a.status === "active");

    if (choices.length > 1) {
      const continuation = await issueTicket(admin, identity, logger);
      // issueTicket returns null when the insert fails. Answering `choose` with
      // no ticket would hand the client a state it cannot act on: it would fall
      // through to the generic success path and try to build a session out of a
      // response that carries no tokens. Fail loudly instead.
      if (!continuation) {
        logger.error("Could not issue a continuation ticket for the account chooser", null, { discordUserId });
        return json({ ok: false, error: "server_error" }, 500);
      }
      logger.info("Discord identity holds several accounts", { discordUserId, count: choices.length });
      return json({
        ok: true,
        state: "choose",
        ticket: continuation,
        discord_username: consumed.discordUsername,
        display_name: consumed.displayName,
        accounts: choices.map((a: any) => ({ id: a.id, role: a.role, guild: a.guild ?? null })),
      });
    }
    // Exactly one of them is still active: sign straight in, no pointless
    // dialog with a single button.
    if (choices.length === 1) {
      return await mintForAccount(req, admin, logger, choices[0].id as string, choices[0].role as string);
    }
    // All of them suspended. Same answer a single suspended account gets.
    logger.warn("Every linked account is inactive", { discordUserId });
    return json({ ok: false, error: "pending_approval" }, 200);
  }

  if (!link || !link.account_id) {
    logger.info("Discord account is not linked to any account", { discordUserId });
    const continuation = await issueTicket(admin, identity, logger);
    // Same rule as the chooser: `unlinked` without a ticket is a state the
    // client cannot act on, so it is reported as the server fault it is.
    if (!continuation) {
      logger.error("Could not issue a continuation ticket for an unlinked identity", null, { discordUserId });
      return json({ ok: false, error: "server_error" }, 500);
    }
    return json({
      ok: true,
      state: "unlinked",
      ticket: continuation,
      discord_username: consumed.discordUsername,
      display_name: consumed.displayName,
    });
  }

  return await mintForAccount(req, admin, logger, link.account_id as string);
}
