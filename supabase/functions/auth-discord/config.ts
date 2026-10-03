/**
 * supabase/functions/auth-discord/config.ts
 *
 * Configuration (Discord OAuth secrets from the environment), lifetimes, rate-limit
 * budgets, and the Zod schema of every POST action.
 */

import { z } from "https://esm.sh/zod@3.23.8";
import { getValidatedEnv } from "../_shared/env.ts";

export const env = getValidatedEnv();
export const SUPABASE_URL = env.SUPABASE_URL;
export const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
export const ANON_KEY = env.SUPABASE_ANON_KEY;

export const CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID") ?? "";
export const CLIENT_SECRET = Deno.env.get("DISCORD_CLIENT_SECRET") ?? "";
export const REDIRECT_URI = Deno.env.get("DISCORD_OAUTH_REDIRECT_URI") ?? "";
export const DEFAULT_ORIGIN = Deno.env.get("APP_DEFAULT_ORIGIN") ?? "";

/** Lifetimes. The state spans a human consent click; the ticket spans a redirect. */
export const STATE_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 2 * 60_000;

// A continuation ticket waits on a PERSON, not on a redirect. Two minutes is
// right for the ticket that travels in the callback URL and is spent
// immediately; it is far too short for one that sits on screen while someone
// reads two options, or types a password into the claim form. Both expired
// under the owner mid-decision.
export const CONTINUATION_TTL_MS = 15 * 60_000;

/**
 * How many times a continuation may be re-issued after a recoverable mistake.
 * Mirrors the CHECK on `discord_auth_tickets.attempts` (migration
 * 20261002120000), which is the real bound: one Discord authorization is worth
 * at most MAX_TICKET_ATTEMPTS + 1 attempts.
 */
export const MAX_TICKET_ATTEMPTS = 5;

/**
 * Errors the person can fix by editing a field and trying again. Everything
 * else -- an identity already linked, an account too young, a daily cap, a
 * locked account, a server fault, a rate limit -- is not fixed by retyping,
 * so it spends the chain and the client offers a fresh Discord sign-in.
 */
export const RECOVERABLE_ERRORS = new Set([
  "invalid_code",
  "code_invalid",
  "invalid_uid",
  "uid_not_in_guild",
  "uid_already_claimed",
  "invalid_guild_tag",
  "invalid_server_number",
  "tag_taken",
  "invalid_credentials",
]);

/** Shared with auth-login — login_throttle is keyed purely by IP. */
export const IP_LIMIT = { limit: 60, windowMs: 300_000 };

/**
 * The claim verifies a password, so it is a guessing oracle and gets its own,
 * tighter budget rather than the shared one. Two things already make it
 * expensive to abuse — a ticket is spent per attempt, and a ticket costs a full
 * Discord round trip — but neither is a budget, so this is.
 */
export const CLAIM_IP_LIMIT = { limit: 20, windowMs: 300_000 };
/** Second budget, keyed by Discord account, so rotating IPs buys nothing. */
export const CLAIM_DISCORD_LIMIT = { limit: 10, windowMs: 3_600_000 };

export const TicketField = z.string().trim().min(16).max(256);

export const RedeemSchema = z.object({
  action: z.literal("redeem"),
  ticket: TicketField,
});

/**
 * Phase D6/D5: spend a single-use code.
 *
 * ONE action for both kinds, because the person holding the code has no reason
 * to know whether an admin issued them a `relink` (reattach an existing
 * account) or an `admin_invite` (provision a new one). Making them choose would
 * be an invitation to burn a ticket on the wrong guess.
 */
// A Discord identity may hold several accounts (an administrator who is also a
// player). `redeem` answers `state: "choose"` in that case and hands back a
// continuation ticket; this spends it on one of them. The account id is
// checked against the LINKS for the ticket's Discord identity, never trusted:
// without that this endpoint would be "mint me a session for any account id".
export const ChooseSchema = z.object({
  action: z.literal("choose"),
  ticket: TicketField,
  account_id: z.string().min(1).max(64),
});

export const RedeemCodeSchema = z.object({
  action: z.literal("redeem-code"),
  ticket: TicketField,
  code: z.string().trim().min(4).max(128),
});

/**
 * Phase D4: a first sign-in with no account, choosing a way in.
 *
 * `join` needs the guild's join code and the caller's in-game UID; `create`
 * needs a free tag and a server number. Discriminated on `mode` so a caller
 * cannot supply one set of fields and reach the other branch.
 */
export const OnboardSchema = z.discriminatedUnion("mode", [
  z.object({
    action: z.literal("onboard"),
    mode: z.literal("join"),
    ticket: TicketField,
    join_code: z.string().trim().min(1).max(64),
    uid: z.string().trim().regex(/^[0-9]{1,20}$/),
  }),
  z.object({
    action: z.literal("onboard"),
    mode: z.literal("create"),
    ticket: TicketField,
    guild_tag: z.string().trim().min(2).max(12),
    server_number: z.string().trim().regex(/^[0-9]{4}$/),
  }),
]);

/** Phase D3: prove you own the password, and the account becomes Discord-only. */
export const ClaimSchema = z.object({
  action: z.literal("claim"),
  ticket: TicketField,
  id: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});

/** Phase D6: the super_admin's way back in when Discord itself is the problem. */
export const BackupLoginSchema = z.object({
  action: z.literal("backup-login"),
  id: z.string().trim().min(1).max(128),
  code: z.string().trim().min(4).max(64),
});
