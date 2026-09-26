/**
 * supabase/functions/_shared/session-epoch.ts
 *
 * Reading the session epoch (`app_metadata.session_version`) out of a bearer
 * token. Dependency-free on purpose: this is the one piece of finding C1 that
 * can be unit-tested, and `_shared/auth.ts` cannot be imported under Vitest
 * because it pulls the Supabase client from esm.sh. Same reasoning as
 * `_shared/discord-oauth.ts` and `_shared/admin-authz.ts`.
 */

/**
 * Reads `app_metadata.session_version` from the token's OWN payload.
 *
 * WHY NOT `user.app_metadata` AS RETURNED BY getUser(): that call asks GoTrue,
 * which answers from the CURRENT `auth.users` row, so its `session_version` is
 * always the freshly bumped one. Comparing it against `accounts` would compare
 * the database to itself and pass every single time -- a check that reads
 * correctly and verifies nothing. The epoch we need is the one frozen into the
 * token when it was minted, and only the token carries it.
 *
 * Decoding a payload without verifying it would normally be unsafe. Callers
 * invoke this only AFTER `getUser()` has returned a user, which means GoTrue
 * already verified the signature: this reads a claim from a token whose
 * authenticity is established, it does not trust an attacker-supplied blob.
 *
 * Returns null when the claim is absent or unreadable, which callers treat as a
 * legacy token. That tolerance is required during the Discord migration -- 122
 * of 171 GoTrue users had no such claim, so a strict check would have cut
 * database access for 71% of the user base. See
 * `20260926250000_real_session_revocation.sql`.
 */
export function readTokenSessionVersion(jwt: string): number | null {
  try {
    const payload = String(jwt ?? "").split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const claims = JSON.parse(atob(padded));
    const raw = claims?.app_metadata?.session_version;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * True when a token's epoch is superseded by the account's.
 *
 * Absent-tolerant, and deliberately identical in behaviour to the SQL
 * `gm_session_is_valid()`. The two must not disagree: if they did, an account
 * would be refused by RLS while the Edge Functions still served it, or the
 * reverse -- and either way the discrepancy would be invisible until someone
 * hit it in production.
 */
export function isSessionRevoked(jwt: string, accountVersion: number | null | undefined): boolean {
  const tokenVersion = readTokenSessionVersion(jwt);
  if (tokenVersion === null) return false;
  return tokenVersion !== (accountVersion ?? 0);
}
