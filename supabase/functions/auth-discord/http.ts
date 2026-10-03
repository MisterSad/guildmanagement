/**
 * supabase/functions/auth-discord/http.ts
 *
 * Response helpers: JSON with CORS, no-store redirects, and the trusted return
 * origin.
 */

import { getCorsHeaders, isAllowedOrigin } from "../_shared/cors.ts";
import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, DEFAULT_ORIGIN } from "./config.ts";

export function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

/** 302 without caching: these URLs are single-use and must never be replayed from cache. */
export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

/** True only when every Discord OAuth secret is present. */
export function configured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI && DEFAULT_ORIGIN);
}

/**
 * Resolves the origin to send the user back to.
 *
 * Falls back to APP_DEFAULT_ORIGIN rather than trusting the caller: an origin
 * that does not satisfy isAllowedOrigin() is never stored, so the callback can
 * only ever redirect somewhere this deployment already trusts.
 */
export function resolveOrigin(raw: string | null): string {
  if (raw && isAllowedOrigin(raw)) return raw;
  return DEFAULT_ORIGIN;
}
