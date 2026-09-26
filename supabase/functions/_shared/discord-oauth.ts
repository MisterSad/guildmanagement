/**
 * supabase/functions/_shared/discord-oauth.ts
 *
 * Pure helpers for the Discord OAuth2 authorization-code flow with PKCE.
 *
 * Deliberately free of Deno.env, network and database access so the whole
 * module runs under Vitest exactly as `_shared/admin-authz.ts` does. Every
 * security-relevant computation of the flow lives here: the PKCE pair, the
 * authorize URL (which pins the scope), and the snowflake-to-date conversion
 * used by the account-age guardrail.
 *
 * NOTE ON THE SNOWFLAKE: `snowflakeToDate` exists for display and for
 * client-side hints only. The account-age guardrail that actually gates guild
 * creation (D4) MUST be recomputed in SQL inside the same transaction that
 * creates the guild — an Edge Function result is a value the caller could
 * otherwise influence by ordering. See the D4 notes.
 */

/** Discord's epoch: 2015-01-01T00:00:00Z, in milliseconds. */
export const DISCORD_EPOCH_MS = 1420070400000;

export const DISCORD_AUTHORIZE_URL = "https://discord.com/api/oauth2/authorize";
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_REVOKE_URL = "https://discord.com/api/oauth2/token/revoke";
export const DISCORD_ME_URL = "https://discord.com/api/users/@me";

/**
 * The ONLY scope this integration ever requests.
 *
 * `identify` returns the user id, username and avatar — nothing else. We
 * deliberately never ask for `email` (we hold no e-mail column and want none)
 * nor `guilds` (the bot already knows the guilds it is in, through the
 * Gateway worker, without the user granting anything).
 */
export const DISCORD_SCOPE = "identify";

/** URL-safe base64 with the padding stripped (RFC 7636 §A). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `size` cryptographically random bytes, base64url encoded. */
export function randomToken(size = 32): string {
  const b = new Uint8Array(size);
  crypto.getRandomValues(b);
  return base64UrlEncode(b);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * Generates a PKCE verifier and its S256 challenge.
 *
 * PKCE is not strictly required for a confidential client (we hold a client
 * secret and exchange the code server-side), but it costs one hash and closes
 * the authorization-code injection class outright: a `code` intercepted in
 * transit is useless without the verifier, which never leaves the database.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  // 32 bytes -> 43 chars, comfortably inside RFC 7636's 43..128 range.
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)), method: "S256" };
}

/**
 * Builds the Discord authorization URL.
 *
 * `prompt=none` is intentionally NOT used: a returning user should still see
 * Discord's own consent screen the first time, and forcing `none` turns a
 * first-time authorization into an opaque error redirect.
 */
export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: DISCORD_SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${DISCORD_AUTHORIZE_URL}?${q.toString()}`;
}

/**
 * Creation date encoded in a Discord snowflake.
 *
 * Returns null for anything that is not a plausible snowflake, so a caller
 * cannot turn a malformed id into an epoch-0 date that would trivially pass a
 * "account older than N days" check.
 */
export function snowflakeToDate(snowflake: string): Date | null {
  if (typeof snowflake !== "string" || !/^\d{17,20}$/.test(snowflake)) return null;
  let ms: number;
  try {
    ms = Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
  } catch {
    return null;
  }
  if (!Number.isFinite(ms) || ms < DISCORD_EPOCH_MS) return null;
  return new Date(ms);
}

/** Whole days between a snowflake's creation and `now`; null if unparseable. */
export function snowflakeAgeDays(snowflake: string, now: number = Date.now()): number | null {
  const created = snowflakeToDate(snowflake);
  if (!created) return null;
  return Math.floor((now - created.getTime()) / 86_400_000);
}

/**
 * Appends the one-time ticket to the origin the sign-in started from.
 *
 * The origin must already have been validated with `isAllowedOrigin`; this
 * function only assembles, it does not authorize. Any path, query or fragment
 * on the stored origin is dropped — the ticket must land on the app root, and
 * carrying an attacker-chosen path through would be an open redirect.
 */
export function buildReturnUrl(origin: string, ticket: string): string {
  const u = new URL(origin);
  return `${u.origin}/?gm_auth=${encodeURIComponent(ticket)}`;
}

/** Same, for the failure path: `?gm_auth_error=<code>` on the app root. */
export function buildErrorReturnUrl(origin: string, code: string): string {
  const u = new URL(origin);
  return `${u.origin}/?gm_auth_error=${encodeURIComponent(code)}`;
}
