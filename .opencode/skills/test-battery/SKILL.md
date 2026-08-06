---
name: test-battery
description: Use when asked to verify, test, run the battery, or check quality before commit in the FGF Guild Management Tool. Covers unit tests (vitest), the security regression matrix, the anonymous surface scan, the e2e portal smoke, and the AGENTS.md §6.5 pre-commit checklist.
---

# FGF Guild Management Tool — Mandatory Test Battery

No change to this repository is complete until the full battery passes AND
the affected surface is regression-tested (AGENTS.md §6, non-negotiable).

## 1. Unit tests (always)

```sh
npm install
npm test          # vitest run — all files, all must pass
npm run test:watch
```

Current suite: **135 tests** across `tests/` (i18n, roles, gm-utils, utils,
stats, shadowfront, cross-rank, subscription, player-register, badges).
When adding a feature, **add unit tests** in the matching test file or a new
`tests/<feature>.test.js`.

## 2. Security regression matrix (after ANY backend/security change)

Create temporary accounts (clean them up afterwards) and verify:

| Check | super_admin | guild_admin (OMEGA) | member (ALPHA) |
|---|---|---|---|
| Read own tenant table | OK | OK | `[]` |
| Read other tenant | OK | `[]` | `[]` |
| Write own tenant | OK | OK | 403/RLS |
| Write other tenant | OK | 403/RLS | 403/RLS |
| Read `guilds` | OK | OK | `[]` |
| Read `accounts` | own + all (policy) | own only | own only |
| Player Portal (member-portal) | — | — | full access |

Use curl against `https://<ref>.supabase.co/rest/v1/...` with a real JWT
(login via the `auth-login` edge function). Expect `[]` for members, data for
admins, `403` on cross-tenant writes.

## 3. Anonymous (anon) surface scan (after ANY grant/function change)

```sql
select p.proname from pg_proc p where has_function_privilege('anon', p.oid, 'EXECUTE');
select table_name from information_schema.role_table_grants where grantee = 'anon' and privilege_type = 'SELECT';
```

Every anon-executable function must return `unauthorized`/empty without a
valid JWT. Every anon-granted table must return `[]` for anon.

## 4. End-to-end smoke (after ANY portal/edge-function change)

1. Register a player (join code + pending) → approve as admin → login.
2. Portal: dashboard loads, charts draw, Active Events submits scores,
   absence + timezone save, transfer request.
3. Reload the page → session survives (portal stays open).
4. Admin of a non-ALPHA guild: login, restriction loads, reads/writes own
   guild, cannot read ALPHA.

## 5. Pre-commit checklist

- [ ] `npm test` — 135 tests, all green
- [ ] No secret/token committed (`sbp_`, `vcp_`, `eyJ`, private keys)
- [ ] New UI strings are English, no em-dashes
- [ ] New tenant table added to `tenantTables` (or consciously excluded)
- [ ] New SQL uses `public.` qualification + `notify pgrst`
- [ ] New function: `revoke ... from public, anon, authenticated` + targeted grants
- [ ] Security matrix from §2 passes for the touched surface
- [ ] `?v=` cache busters bumped for changed assets
- [ ] CHANGELOG.md updated (if user-facing feature)
