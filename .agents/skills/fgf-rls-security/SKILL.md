---
name: fgf-rls-security
description: >-
  Zero-trust access control, Postgres RLS, column grants and Edge Function security for this
  platform. Use when creating or modifying tables, RLS policies, RPCs, grants, Edge Functions,
  or authentication flows.
---

# FGF Zero-Trust & RLS Security

## Roles — four, not three

| Role | Scope |
|---|---|
| `super_admin` | Every tenant. Single account. |
| `server_admin` | Every guild sharing its `server_number`. |
| `guild_admin` | Its own guild only (`accounts.guild`). |
| `member` | **No direct table access.** Goes through the `member-portal` Edge Function. |

These are the only values `accounts.role` may hold; a CHECK constraint enforces it. The legacy `R5`/`R4` ranks and the `admin` alias were retired and are rejected. A role is resolved from `accounts` via `accounts.auth_user_id = auth.uid()` — never from `user_metadata`, never from `localStorage`, never from anything the client supplies.

## Check the grants, not only the policies

**This is the lesson of the worst finding in the 2026-09 audit (C0), and it is the first thing to check on any table holding sensitive columns.**

`GRANT SELECT ON public.accounts TO authenticated` was an **all-columns** grant sitting above perfectly correct policies. Combined with a policy that legitimately let a `guild_admin` read every account in their guild, it exposed `password_hash`, `password_enc` (a *reversible* encryption of the plaintext) and `gotrue_secret_enc` to any guild leader with the publishable key. The policies were not the bug. The grant was.

```sql
-- Grant columns, not tables, whenever a table has a column nobody should read.
REVOKE SELECT ON public.accounts FROM authenticated;
GRANT SELECT (id, role, guild, server_number, uid, status, auth_user_id)
  ON public.accounts TO authenticated;
```

Verify with `information_schema.column_privileges`, not by reading the migration.

## Every `SECURITY DEFINER` function

```sql
SECURITY DEFINER
SET search_path = ''
```

and **fully-qualified references throughout** (`public.accounts`, and note that `pgcrypto` lives in `extensions`, so it is `extensions.digest(...)` — an unqualified call fails at call time and never at create time, so it will pass every test that does not execute it).

Then grant deliberately:

```sql
REVOKE ALL ON FUNCTION public.my_fn(...) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_fn(...) TO authenticated;   -- only if callers need it
```

Trigger functions and maintenance functions get **no** `GRANT EXECUTE` at all. Both classes were once callable over RPC by anyone: `gm_cleanup_expired_ocr_cache()` was executable by `anon`, and `gm_reset_demo_tenant_data()` by any authenticated user of any guild.

## Access-control helpers — reuse, never re-derive

- `public.gm_can_read_guild_data(p_guild)`
- `public.gm_can_read_guilds()`
- `public.gm_can_read_account(p_account_id)`
- `public.check_user_guild_access(p_guild)` / `public.check_user_guild_write_access(p_guild)`
- `public.gm_is_admin_caller()` / `public.is_super_admin()` / `public.is_server_admin()`
- `public.gm_can_admin_see_absences(p_guild)`

`public.is_subscription_active(p_guild)` also appears in ~44 policy clauses. It is a literal `SELECT true` — the app is free (ADR-015) — and survives only because rewriting those clauses is the riskiest remaining change. **Do not treat it as a live gate, and do not add new calls to it.**

## Session revocation

`accounts.session_version` is bumped on password reset, role change and suspension. `public.gm_session_is_valid()` compares it to the JWT's `app_metadata.session_version` and is folded into the six helpers above, so no policy needs to call it directly.

The comparison is **absent-tolerant by design**: a token with no claim is accepted as legacy; a token with a *stale* claim is refused. A strict check would have cut off 71% of users at deploy. Epoch `0` is a real epoch, not "unset" — most accounts sit there.

Read the epoch **from the token payload**, never from `auth.getUser(jwt)`: that answers from the current `auth.users` row, so it returns the new epoch for an old token and the check silently always passes.

## Edge Functions

- Validate every input with **Zod**. Bound numbers.
- Resolve identity from the JWT. Never trust a client-supplied account id, uid or guild.
- `validateCallerAuth` enforces `status = 'active'` centrally — do not re-implement it per function, and do not skip it.
- `verify_jwt` in `supabase/config.toml` must match what is deployed (ADR-017). In-handler verification is defence in depth, not a substitute.
- SSRF: webhook URLs are resolved **server-side from `guild_config`**, never taken from the client. Host allowlist, path regex, pinned port, `redirect: "error"`, timeout.
- Rate limits must fail **closed**. Returning `{ allowed: true }` on a database error means pressure on the database disables login throttling.
- Never interpolate user input into an LLM prompt.

## Deny-all tables

RLS enabled with **zero policies** is a deliberate deny-all for service-role-only tables — but say so, with a `COMMENT ON TABLE`. An undocumented empty result is indistinguishable from a bug, and a future developer will spend a day on it.

Note that `FORCE ROW LEVEL SECURITY` is **cosmetic** against `postgres` and `service_role`: both hold `rolbypassrls`. It protects against a table owner, not against the service key.

## Filters

Never build a PostgREST filter by string concatenation (`.or('a.eq.' + input)`). Never use `.ilike()` on an identifier for an `UPDATE` — `payload.id = '%'` rewrites every row. Use `.eq()`, and reject `%`, `_` and `\` in identifier schemas.
