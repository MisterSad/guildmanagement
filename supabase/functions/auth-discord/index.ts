/**
 * supabase/functions/auth-discord/index.ts
 *
 * Discord sign-in (Phase D2). Three routes:
 *
 *   GET  /auth-discord/start?origin=<app origin>
 *        Validates the origin, mints a state + PKCE pair, 302s to Discord.
 *
 *   GET  /auth-discord/callback?code=&state=
 *        Consumes the state, exchanges the code server-side, reads the Discord
 *        identity, revokes the token, issues a one-time ticket and 302s back to
 *        the origin the flow started from.
 *
 *   POST /auth-discord            { action: "redeem", ticket }
 *        Spends the ticket and mints the real GoTrue session.
 *
 * WHY THE REDIRECT URI POINTS HERE AND NOT AT THE APP
 * Discord requires an exact redirect match, and the app is reachable from the
 * Vercel domain, every preview URL and localhost. Pointing the single
 * registered URI at this function makes one URI cover every origin, and the
 * `code` is exchanged server-side without ever touching the browser.
 *
 * WHY A TICKET RATHER THAN A FRAGMENT OR A POPUP
 * `vercel.json` sets `Cross-Origin-Opener-Policy: same-origin`, which severs
 * `window.opener` — the usual popup + postMessage handshake would never fire.
 * So this is a full-page redirect, and what comes back in the URL is a ticket
 * that carries NO session: it only attests that this browser completed a
 * Discord authorization. The session is minted when the SPA redeems it over
 * POST, server-side. A ticket leaked through a Referer header or shoulder-surf
 * is worth one redemption inside two minutes, not a bearer token.
 *
 * verify_jwt = false: no session exists at this point, by definition. Every
 * route authenticates by its own means (single-use state, single-use ticket).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders, isAllowedOrigin } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { establishShadowSession } from "../_shared/shadow-session.ts";
import { getValidatedEnv } from "../_shared/env.ts";
import {
  BACKUP_CODE_LENGTH,
  issueBackupCodes,
  normalizeBackupCode,
  sha256Hex,
  verifyAndConsumeBackupCode,
} from "../_shared/backup-codes.ts";
import {
  DISCORD_ME_URL,
  DISCORD_REVOKE_URL,
  DISCORD_TOKEN_URL,
  buildAuthorizeUrl,
  buildErrorReturnUrl,
  buildReturnUrl,
  generatePkcePair,
  randomToken,
} from "../_shared/discord-oauth.ts";

const env = getValidatedEnv();
const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.SUPABASE_ANON_KEY;

const CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("DISCORD_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("DISCORD_OAUTH_REDIRECT_URI") ?? "";
const DEFAULT_ORIGIN = Deno.env.get("APP_DEFAULT_ORIGIN") ?? "";

/** Lifetimes. The state spans a human consent click; the ticket spans a redirect. */
const STATE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 2 * 60_000;

/** Shared with auth-login and auth-passkey — login_throttle is keyed purely by IP. */
const IP_LIMIT = { limit: 60, windowMs: 300_000 };

/**
 * The claim verifies a password, so it is a guessing oracle and gets its own,
 * tighter budget rather than the shared one. Two things already make it
 * expensive to abuse — a ticket is spent per attempt, and a ticket costs a full
 * Discord round trip — but neither is a budget, so this is.
 */
const CLAIM_IP_LIMIT = { limit: 20, windowMs: 300_000 };
/** Second budget, keyed by Discord account, so rotating IPs buys nothing. */
const CLAIM_DISCORD_LIMIT = { limit: 10, windowMs: 3_600_000 };

const TicketField = z.string().trim().min(16).max(256);

const RedeemSchema = z.object({
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
const RedeemCodeSchema = z.object({
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
const OnboardSchema = z.discriminatedUnion("mode", [
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
const ClaimSchema = z.object({
  action: z.literal("claim"),
  ticket: TicketField,
  id: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});

/** Phase D6: the super_admin's way back in when Discord itself is the problem. */
const BackupLoginSchema = z.object({
  action: z.literal("backup-login"),
  id: z.string().trim().min(1).max(128),
  code: z.string().trim().min(4).max(64),
});

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

/** 302 without caching: these URLs are single-use and must never be replayed from cache. */
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

/** True only when every Discord OAuth secret is present. */
function configured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI && DEFAULT_ORIGIN);
}

/**
 * Resolves the origin to send the user back to.
 *
 * Falls back to APP_DEFAULT_ORIGIN rather than trusting the caller: an origin
 * that does not satisfy isAllowedOrigin() is never stored, so the callback can
 * only ever redirect somewhere this deployment already trusts.
 */
function resolveOrigin(raw: string | null): string {
  if (raw && isAllowedOrigin(raw)) return raw;
  return DEFAULT_ORIGIN;
}

/** Mints a single-use ticket for a Discord identity. Returns null on failure. */
async function issueTicket(
  admin: any,
  discordUserId: string,
  discordUsername: string | null,
  logger: EdgeLogger
): Promise<string | null> {
  const ticket = randomToken(32);
  const { error } = await admin.from("discord_auth_tickets").insert({
    ticket,
    discord_user_id: discordUserId,
    discord_username: discordUsername,
    expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
  });
  if (error) {
    logger.error("Failed to persist auth ticket", error);
    return null;
  }
  return ticket;
}

// ── GET /start ──────────────────────────────────────────────────────────────
async function handleStart(req: Request, url: URL, admin: any, logger: EdgeLogger): Promise<Response> {
  const origin = resolveOrigin(url.searchParams.get("origin"));

  const ip = extractClientIp(req.headers);
  const throttle = await checkAndRecordIpAttempt(admin, ip, IP_LIMIT);
  if (!throttle.allowed) {
    logger.warn("IP rate limit exceeded on Discord start", { ip });
    return redirect(buildErrorReturnUrl(origin, "too_many_attempts"));
  }

  const state = randomToken(32);
  const pkce = await generatePkcePair();

  const { error } = await admin.from("discord_oauth_states").insert({
    state,
    code_verifier: pkce.verifier,
    origin,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) {
    logger.error("Failed to persist OAuth state", error);
    return redirect(buildErrorReturnUrl(origin, "server_error"));
  }

  return redirect(buildAuthorizeUrl({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    state,
    codeChallenge: pkce.challenge,
  }));
}

// ── GET /callback ───────────────────────────────────────────────────────────
async function handleCallback(req: Request, url: URL, admin: any, logger: EdgeLogger): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";

  // The state is consumed FIRST and atomically (DELETE ... RETURNING), so a
  // replayed callback finds nothing. Until it resolves we do not know the real
  // origin, so errors before this point go to the default origin.
  const { data: stateRows, error: stateErr } = await admin
    .rpc("gm_consume_discord_oauth_state", { p_state: state });
  if (stateErr) {
    logger.error("Failed to consume OAuth state", stateErr);
    return redirect(buildErrorReturnUrl(DEFAULT_ORIGIN, "server_error"));
  }
  const stateRow = Array.isArray(stateRows) ? stateRows[0] : stateRows;
  if (!stateRow) {
    // Unknown, already-used or expired state. Also the path a CSRF attempt
    // takes, since an attacker cannot produce a state we issued.
    logger.warn("Unknown or expired OAuth state on callback");
    return redirect(buildErrorReturnUrl(DEFAULT_ORIGIN, "state_invalid"));
  }

  const origin = isAllowedOrigin(stateRow.origin) ? stateRow.origin : DEFAULT_ORIGIN;

  // Discord reports user denial as ?error=access_denied, with no code.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    logger.info("User declined Discord authorization", { oauthError });
    return redirect(buildErrorReturnUrl(origin, "cancelled"));
  }
  if (!code) return redirect(buildErrorReturnUrl(origin, "missing_code"));

  // ── Exchange the code. The verifier proves we are the client that started
  //    this flow; it never left the database.
  let accessToken = "";
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: stateRow.code_verifier,
    });
    const res = await fetch(DISCORD_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      logger.error("Discord token exchange failed", { status: res.status });
      return redirect(buildErrorReturnUrl(origin, "exchange_failed"));
    }
    const tok = await res.json();
    accessToken = String(tok?.access_token ?? "");
    if (!accessToken) return redirect(buildErrorReturnUrl(origin, "exchange_failed"));
  } catch (err) {
    logger.error("Discord token exchange threw", err);
    return redirect(buildErrorReturnUrl(origin, "exchange_failed"));
  }

  // ── Read the identity, then immediately give the token back. We hold no
  //    Discord token at rest: everything we need is the user id.
  let discordUserId = "";
  let discordUsername: string | null = null;
  try {
    const res = await fetch(DISCORD_ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      logger.error("Discord /users/@me failed", { status: res.status });
      return redirect(buildErrorReturnUrl(origin, "identity_failed"));
    }
    const me = await res.json();
    discordUserId = String(me?.id ?? "");
    discordUsername = me?.username ? String(me.username) : null;
    if (!/^\d{17,20}$/.test(discordUserId)) {
      return redirect(buildErrorReturnUrl(origin, "identity_failed"));
    }
  } catch (err) {
    logger.error("Discord /users/@me threw", err);
    return redirect(buildErrorReturnUrl(origin, "identity_failed"));
  } finally {
    // Best effort: a revoke that fails must not block a sign-in that already
    // succeeded, and there is nothing to revoke if the exchange never produced
    // a token. Runs on every exit path out of the block above, including the
    // early returns, which is the point — we hold no Discord token at rest.
    try {
      if (accessToken) await fetch(DISCORD_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          token: accessToken,
          token_type_hint: "access_token",
        }),
      });
    } catch { /* ignore */ }
  }

  // ── Issue the ticket. Note it is issued whether or not the Discord account
  //    is linked: resolving that is the redeem step's job, and it is what D3
  //    (claim) and D4 (onboarding) will extend.
  const ticket = await issueTicket(admin, discordUserId, discordUsername, logger);
  if (!ticket) return redirect(buildErrorReturnUrl(origin, "server_error"));

  logger.info("Discord authorization completed", { discordUserId });
  return redirect(buildReturnUrl(origin, ticket));
}

/** Spends a ticket, returning the Discord identity it attested. */
async function consumeTicket(
  admin: any,
  ticket: string,
  logger: EdgeLogger
): Promise<{ ok: true; discordUserId: string; discordUsername: string | null } | { ok: false; error: string; status: number }> {
  const { data: rows, error } = await admin.rpc("gm_consume_discord_auth_ticket", { p_ticket: ticket });
  if (error) {
    logger.error("Failed to consume auth ticket", error);
    return { ok: false, error: "server_error", status: 500 };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return { ok: false, error: "ticket_invalid", status: 200 };
  return { ok: true, discordUserId: row.discord_user_id as string, discordUsername: row.discord_username ?? null };
}

/** Shared IP budget check for every POST action. */
async function throttled(req: Request, admin: any, logger: EdgeLogger, what: string): Promise<boolean> {
  const ip = extractClientIp(req.headers);
  const t = await checkAndRecordIpAttempt(admin, ip, IP_LIMIT);
  if (!t.allowed) logger.warn("IP rate limit exceeded", { ip, what });
  return !t.allowed;
}

// ── POST { action: "redeem", ticket } ───────────────────────────────────────
async function handleRedeem(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = RedeemSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "redeem")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);
  const row = { discord_username: consumed.discordUsername };
  const discordUserId = consumed.discordUserId;

  const { data: link, error: lErr } = await admin
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (lErr) {
    logger.error("Failed to resolve Discord link", lErr, { discordUserId });
    return json({ ok: false, error: "server_error" }, 500);
  }

  // No link yet. The original ticket has just been spent, so a CONTINUATION
  // ticket is issued for the same Discord identity: without it the caller
  // would have to restart the whole Discord round trip merely to present a
  // relink code. It is single-use and short-lived exactly like the first.
  //
  // D6 uses this to accept a relink code; D3 (claim) and D4 (onboarding) hang
  // off the same branch and the same continuation ticket.
  if (!link || !link.account_id) {
    logger.info("Discord account is not linked to any account", { discordUserId });
    const continuation = await issueTicket(admin, discordUserId, row.discord_username ?? null, logger);
    return json({
      ok: true,
      state: "unlinked",
      ticket: continuation,
      discord_username: row.discord_username ?? null,
    });
  }

  const accountId = link.account_id as string;
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
    // The link outlived its account.
    logger.warn("Discord link points at a missing account", { accountId });
    return json({ ok: true, state: "unlinked", discord_username: row.discord_username ?? null });
  }
  // Finding M14: status must be enforced, not merely returned.
  if (acc.status !== "active") {
    logger.warn("Suspended or pending account attempted Discord sign-in", { accountId, status: acc.status });
    return json({ ok: false, error: "pending_approval" }, 200);
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
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

// ── POST { action: "redeem-code", ticket, code } — phases D6 + D5 ──────────
//
// Two kinds of code arrive here:
//   * `relink`       — reattach an EXISTING account whose link was removed, or
//                      was never made (phase D6).
//   * `admin_invite` — provision a NEW admin account in a guild (phase D5).
//
// Both are spent together with a fresh Discord authorization, so possession of
// the code is never sufficient: the person must also prove control of the
// Discord account being attached.
//
// The kind is read first, without consuming: the two RPCs take different
// arguments and each enforces its own single-use semantics under FOR UPDATE.
// A race here loses nothing — the loser gets `code_invalid`, which is exactly
// what a spent code should return.
async function handleRedeemCode(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = RedeemCodeSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "redeem-code")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);

  // Only the hash is ever compared; the plaintext existed once, in the
  // response that handed the code over.
  const codeHash = await sha256Hex(normalizeBackupCode(parsed.data.code));

  const { data: codeRow, error: lookupErr } = await admin
    .from("account_link_codes")
    .select("kind")
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (lookupErr) {
    logger.error("Failed to classify link code", lookupErr);
    return json({ ok: false, error: "server_error" }, 500);
  }
  if (!codeRow) return json({ ok: false, error: "code_invalid" }, 200);

  let row: any;
  if (codeRow.kind === "admin_invite") {
    const { data, error } = await admin.rpc("gm_redeem_admin_invite", {
      p_code_hash: codeHash,
      p_discord_user_id: consumed.discordUserId,
      p_discord_username: consumed.discordUsername ?? "",
    });
    if (error) {
      logger.error("Failed to redeem admin invite", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    row = Array.isArray(data) ? data[0] : data;
  } else {
    const { data, error } = await admin.rpc("gm_redeem_relink_code", {
      p_code_hash: codeHash,
      p_discord_user_id: consumed.discordUserId,
    });
    if (error) {
      logger.error("Failed to redeem relink code", error);
      return json({ ok: false, error: "server_error" }, 500);
    }
    row = Array.isArray(data) ? data[0] : data;
  }

  if (!row || row.ok !== true) {
    logger.warn("Link code rejected", { kind: codeRow.kind, reason: row?.err ?? "unknown" });
    // `discord_already_linked` is surfaced verbatim: it is actionable, and it
    // describes the caller's own Discord account, not someone else's.
    return json({ ok: false, error: row?.err || "code_invalid" }, 200);
  }

  const accountId = row.account_id as string;
  const role = (row.role as string) || "member";
  logger.setContext({ userId: accountId });

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const shadow = await establishShadowSession(admin, anon, accountId, role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("Link code redeemed", {
    kind: codeRow.kind, accountId, role, discordUserId: consumed.discordUserId,
  });

  return json({
    ok: true,
    state: "session",
    kind: codeRow.kind,
    role,
    id: accountId,
    guild: row.guild ?? null,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}

// ── POST { action: "backup-login", id, code } — phase D6 ────────────────────
//
// super_admin ONLY, and deliberately so. Every other account has an
// administrator above it who can unlink and reissue a relink code — a stronger
// path, because it puts a second human in the loop. For those accounts a backup
// code would only be a weaker credential sitting beside the strong one. The
// super_admin has nobody above them, so codes are their sole recovery.
//
// A non-super_admin gets `invalid_code`, identical to a wrong code: the reply
// must not double as a role oracle.
async function handleBackupLogin(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = BackupLoginSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  if (await throttled(req, admin, logger, "backup-login")) return json({ ok: false, error: "too_many_attempts" }, 429);

  const code = normalizeBackupCode(parsed.data.code);
  if (code.length !== BACKUP_CODE_LENGTH) return json({ ok: false, error: "invalid_code" }, 200);

  const { data: acc, error: aErr } = await admin
    .from("accounts")
    .select("id, role, status, locked_until")
    .ilike("id", parsed.data.id)
    .maybeSingle();
  if (aErr) {
    logger.error("Failed to load account for backup sign-in", aErr);
    return json({ ok: false, error: "server_error" }, 500);
  }
  if (!acc || acc.status !== "active" || acc.role !== "super_admin") {
    logger.warn("Backup sign-in refused", { id: parsed.data.id, reason: !acc ? "unknown" : acc.role !== "super_admin" ? "not_super_admin" : "not_active" });
    return json({ ok: false, error: "invalid_code" }, 200);
  }
  if (acc.locked_until && new Date(acc.locked_until).getTime() > Date.now()) {
    logger.warn("Locked account attempted backup sign-in", { id: acc.id });
    return json({ ok: false, error: "account_locked" }, 200);
  }

  const consumed = await verifyAndConsumeBackupCode(admin, acc.id, code);
  if (!consumed.ok) {
    if (consumed.error === "server_error") return json({ ok: false, error: "server_error" }, 500);
    return json({ ok: false, error: "invalid_code" }, 200);
  }

  await admin
    .from("accounts")
    .update({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq("id", acc.id);

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const shadow = await establishShadowSession(admin, anon, acc.id, acc.role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("super_admin signed in with a backup code", { accountId: acc.id, remaining: consumed.remaining });

  return json({
    ok: true,
    state: "session",
    role: acc.role,
    id: acc.id,
    backup_codes_remaining: consumed.remaining,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}

// ── POST { action: "claim", ticket, id, password } — phase D3 ───────────────
//
// IRREVERSIBLE. A successful claim destroys the password, the reversible
// `password_enc` copy, every passkey and every backup code, in the same
// transaction that creates the link. One sign-in method at any instant.
//
// Three things stand between this and a password-guessing oracle, in order of
// how much they cost an attacker: every attempt spends a ticket, and a ticket
// costs a full Discord round trip; a tighter per-IP budget than the other
// actions; and a per-Discord-account budget so rotating IPs buys nothing.
async function handleClaim(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);

  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);

  const ip = extractClientIp(req.headers);
  const ipBudget = await checkAndRecordIpAttempt(admin, ip, CLAIM_IP_LIMIT);
  if (!ipBudget.allowed) {
    logger.warn("IP rate limit exceeded on claim", { ip });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  const consumed = await consumeTicket(admin, parsed.data.ticket, logger);
  if (!consumed.ok) return json({ ok: false, error: consumed.error }, consumed.status);

  // Budget the Discord account itself, now that we know which one it is.
  const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const { data: tRows } = await admin.rpc("gm_check_discord_throttle", {
    p_discord_user_id: consumed.discordUserId,
    p_limit: CLAIM_DISCORD_LIMIT.limit,
    p_window_ms: CLAIM_DISCORD_LIMIT.windowMs,
    p_bucket: bucket,
  });
  const tRow = Array.isArray(tRows) ? tRows[0] : tRows;
  // Fails OPEN on a database error, matching _shared/rate-limit.ts, because
  // the ticket cost already bounds this path hard. (Finding B3 proposes
  // flipping every limiter to fail closed; that is a Phase 4 decision to take
  // across all of them at once, not one endpoint at a time.)
  if (tRow && tRow.allowed === false) {
    logger.warn("Discord-account rate limit exceeded on claim", { discordUserId: consumed.discordUserId });
    return json({ ok: false, error: "too_many_attempts" }, 429);
  }

  const { data: rows, error } = await admin.rpc("gm_claim_account_with_discord", {
    p_id: parsed.data.id,
    p_password: parsed.data.password,
    p_discord_user_id: consumed.discordUserId,
  });
  if (error) {
    logger.error("Claim failed", error);
    return json({ ok: false, error: "server_error" }, 500);
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || row.ok !== true) {
    logger.warn("Claim rejected", { reason: row?.err ?? "unknown", id: parsed.data.id });
    return json({ ok: false, error: row?.err || "invalid_credentials" }, 200);
  }

  const accountId = row.account_id as string;
  const role = (row.role as string) || "member";
  logger.setContext({ userId: accountId });

  // The claim just deleted this account's backup codes. A super_admin has no
  // administrator above them to unlink and reissue, so they must leave this
  // request holding a fresh set — it is their only recovery path once the
  // password is gone. Everyone else is covered by D6's relink code.
  let backupCodes: string[] | undefined;
  if (role === "super_admin") {
    try {
      backupCodes = await issueBackupCodes(admin, accountId);
    } catch (err) {
      logger.error("Failed to issue backup codes after a super_admin claim", err, { accountId });
    }
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const shadow = await establishShadowSession(admin, anon, accountId, role, logger);
  if (!shadow.ok) return json({ ok: false, error: shadow.error }, shadow.status);

  logger.info("Account claimed with Discord", { accountId, role, discordUserId: consumed.discordUserId });

  return json({
    ok: true,
    state: "session",
    claimed: true,
    role,
    id: accountId,
    backup_codes: backupCodes,
    access_token: shadow.session.access_token,
    refresh_token: shadow.session.refresh_token,
    expires_at: shadow.session.expires_at,
  });
}

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
async function handleOnboard(req: Request, body: unknown, admin: any, logger: EdgeLogger): Promise<Response> {
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
    return json({ ok: false, error: row?.err || "onboarding_failed" }, 200);
  }

  const accountId = row.account_id as string;
  const role = (row.role as string) || "member";
  logger.setContext({ userId: accountId });

  // A joined member lands in 'pending' and cannot sign in until an admin
  // approves -- the same rule password self-registration has always had.
  // Report that plainly instead of minting a session that would be refused.
  if (row.status === "pending") {
    logger.info("Player registered through Discord, awaiting approval", { accountId, guild: row.guild });
    return json({
      ok: true,
      state: "pending_approval",
      id: accountId,
      guild: row.guild,
    });
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
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

/** Routes a POST by its `action`, parsing the body exactly once. */
async function handlePost(req: Request, admin: any, logger: EdgeLogger): Promise<Response> {
  const json = makeJson(req);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  switch (body?.action) {
    case "redeem":       return handleRedeem(req, body, admin, logger);
    case "claim":        return handleClaim(req, body, admin, logger);
    case "onboard":      return handleOnboard(req, body, admin, logger);
    case "redeem-code": return handleRedeemCode(req, body, admin, logger);
    case "backup-login": return handleBackupLogin(req, body, admin, logger);
    default:             return json({ ok: false, error: "bad_request" }, 400);
  }
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("auth-discord", req);
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/auth-discord/, "").replace(/\/+$/, "");

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });

  if (!configured()) {
    logger.error("Discord OAuth is not configured", null, {
      hasClientId: Boolean(CLIENT_ID),
      hasClientSecret: Boolean(CLIENT_SECRET),
      hasRedirectUri: Boolean(REDIRECT_URI),
      hasDefaultOrigin: Boolean(DEFAULT_ORIGIN),
    });
    // Fail closed, and never redirect anywhere when we cannot trust our own
    // configuration.
    return json({ ok: false, error: "not_configured" }, 503);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  if (req.method === "GET" && route === "/start") return handleStart(req, url, admin, logger);
  if (req.method === "GET" && route === "/callback") return handleCallback(req, url, admin, logger);
  if (req.method === "POST" && (route === "" || route === "/")) return handlePost(req, admin, logger);

  return json({ ok: false, error: "not_found" }, 404);
});
