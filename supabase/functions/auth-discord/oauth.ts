/**
 * supabase/functions/auth-discord/oauth.ts
 *
 * The two GET routes: /start sends the browser to Discord, /callback exchanges
 * the code server-side and returns a ticket.
 */

import { type EdgeLogger } from "../_shared/logger.ts";
import { isAllowedOrigin } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { DISCORD_ME_URL, DISCORD_REVOKE_URL, DISCORD_TOKEN_URL, buildAuthorizeUrl, buildErrorReturnUrl, buildReturnUrl, generatePkcePair, randomToken } from "../_shared/discord-oauth.ts";
import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, DEFAULT_ORIGIN, STATE_TTL_MS, TICKET_TTL_MS, IP_LIMIT } from "./config.ts";
import { redirect, resolveOrigin } from "./http.ts";
import { issueTicket } from "./tickets.ts";

// ── GET /start ──────────────────────────────────────────────────────────────
export async function handleStart(req: Request, url: URL, admin: any, logger: EdgeLogger): Promise<Response> {
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
export async function handleCallback(_req: Request, url: URL, admin: any, logger: EdgeLogger): Promise<Response> {
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
  let displayName: string | null = null;
  try {
    const res = await fetch(DISCORD_ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      logger.error("Discord /users/@me failed", { status: res.status });
      return redirect(buildErrorReturnUrl(origin, "identity_failed"));
    }
    const me = await res.json();
    discordUserId = String(me?.id ?? "");
    discordUsername = me?.username ? String(me.username) : null;
    // `global_name` is the name friends see; null when the person never set
    // one. Display only, capped to the column's CHECK.
    displayName = me?.global_name ? String(me.global_name).slice(0, 64) : null;
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
  // The SHORT lifetime: this one travels in the callback URL and is spent by
  // the SPA within a second of landing. Continuations, which wait on a person,
  // get CONTINUATION_TTL_MS instead.
  const ticket = await issueTicket(
    admin, { discordUserId, discordUsername, displayName, attempts: 0 }, logger, TICKET_TTL_MS,
  );
  if (!ticket) return redirect(buildErrorReturnUrl(origin, "server_error"));

  logger.info("Discord authorization completed", { discordUserId });
  return redirect(buildReturnUrl(origin, ticket));
}
