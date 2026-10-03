/**
 * supabase/functions/auth-discord/index.ts
 *
 * Discord sign-in. Three routes:
 *
 *   GET  /auth-discord/start?origin=<app origin>
 *        Validates the origin, mints a state + PKCE pair, 302s to Discord.
 *
 *   GET  /auth-discord/callback?code=&state=
 *        Consumes the state, exchanges the code server-side, reads the Discord
 *        identity, revokes the token, issues a one-time ticket and 302s back to
 *        the origin the flow started from.
 *
 *   POST /auth-discord            { action, ticket, ... }
 *        `redeem` spends the callback ticket: a session, an account chooser
 *        (`choose`), or `unlinked` with a continuation ticket. `claim`,
 *        `onboard` and `redeem-code` spend a continuation; on a recoverable
 *        mistake they hand back a fresh one, at most MAX_TICKET_ATTEMPTS times
 *        per Discord authorization. `backup-login` is the super_admin's
 *        ticketless recovery.
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
 *
 * LAYOUT
 *   config.ts   secrets, lifetimes, budgets, the POST schemas
 *   http.ts     JSON / redirect helpers, the trusted return origin
 *   oauth.ts    GET /start and GET /callback
 *   tickets.ts  issuing and spending tickets, minting the session
 *   actions/    one module per POST action
 */

import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";
import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, DEFAULT_ORIGIN } from "./config.ts";
import { makeJson, configured } from "./http.ts";
import { handleStart, handleCallback } from "./oauth.ts";
import { handleChoose, handleRedeem } from "./actions/redeem.ts";
import { handleRedeemCode } from "./actions/redeem-code.ts";
import { handleBackupLogin } from "./actions/backup-login.ts";
import { handleClaim } from "./actions/claim.ts";
import { handleOnboard } from "./actions/onboard.ts";

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
    case "choose":       return handleChoose(req, body, admin, logger);
    case "claim":        return handleClaim(req, body, admin, logger);
    case "onboard":      return handleOnboard(req, body, admin, logger);
    case "redeem-code": return handleRedeemCode(req, body, admin, logger);
    case "backup-login": return handleBackupLogin(req, body, admin, logger);
    default:             return json({ ok: false, error: "bad_request" }, 400);
  }
}

export async function handler(req: Request): Promise<Response> {
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

  const admin = serviceClient();

  if (req.method === "GET" && route === "/start") return handleStart(req, url, admin, logger);
  if (req.method === "GET" && route === "/callback") return handleCallback(req, url, admin, logger);
  if (req.method === "POST" && (route === "" || route === "/")) return handlePost(req, admin, logger);

  return json({ ok: false, error: "not_found" }, 404);
}

serveUnlessTest(handler);
