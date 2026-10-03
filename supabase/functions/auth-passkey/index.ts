/**
 * supabase/functions/auth-passkey/index.ts -- TOMBSTONE
 *
 * Passkeys were removed on 2026-10-03 (owner decision). Sign-in is Discord, with
 * ID + password kept during the transition. The super_admin's recovery codes
 * live on in the Discord flow: auth-discord `backup-login` and admin-accounts
 * `backup-codes-*`.
 *
 * This file only exists so the deployed function stops working. Deleting the
 * directory would leave the last deployed version live: the 14 accounts that
 * held a passkey could still have signed in with it by calling the API
 * directly. Every request now gets 410 Gone, and the passkey tables are
 * dropped.
 *
 * Once this tombstone is deployed, the function can be deleted from the
 * Supabase dashboard. Then this directory and its [functions.auth-passkey]
 * block in config.toml go too, keeping the repository and production in step
 * (ADR-017).
 */

import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  return new Response(JSON.stringify({ ok: false, error: "passkeys_removed" }), {
    status: 410,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
});
