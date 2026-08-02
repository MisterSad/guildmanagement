# AGENTS.md — Development Guidelines for AI Agents

This file is the single source of truth for anyone (human or AI) modifying
this repository. **Read it fully before touching any code.** Every change
must respect the rules below, especially the security model and the test
battery.

---

## 1. Project overview

**FGF Guild Management Tool** is a serverless, multi-tenant web app that
helps guilds in the game *Foundation Galactic Frontier* manage events,
members, participation, sanctions, Discord notifications and subscriptions.

- **Frontend**: vanilla JavaScript (ES5-style IIFEs, `var`, no framework,
  no build step), hand-written CSS design system, Phosphor Icons, Three.js
  for the 3D login scene, installable PWA.
- **Backend**: Supabase (Postgres 17 + RLS + `SECURITY DEFINER` functions,
  Edge Functions in TypeScript/Deno).
- **Payments**: external merchant API (server-side order creation +
  HMAC-verified webhook). The provider name must never appear in public
  docs; it may change.
- **Tests**: Vitest + jsdom (`npm test`).
- **Hosting**: static files on Vercel, auto-deploy on push to `main`.

---

## 2. The three-role access model (CRITICAL)

There are exactly three account roles. **Never blur the boundaries.**

| Role | Access |
|------|--------|
| `super_admin` | Reads and writes **every guild**. Single account (HawkEye). Also "base admin" of ALPHA. |
| `guild_admin` | Reads and writes **only their own guild** (tenants: ALPHA, OMEGA, BABE, IMK, YARR). |
| `member` | **Player Portal only** (scores, power, timezone, absences, transfers). NO direct database access. |

**A player account must never be able to reach the admin dashboard or
read/write any guild data through the REST API.**

### Golden rules

1. A `member` account gets `[]` (or denial) on **every** tenant table and
   on `guilds` and `accounts` (except its own row).
2. A `guild_admin` sees only their guild's rows, and only `guilds` rows
   (all of them — needed for transfers) plus their own `accounts` row.
3. `super_admin` bypasses guild scoping everywhere.
4. The Player Portal (`portal.js`) must never query tables directly: it
   only calls the `member-portal` edge function (service_role), which
   resolves identity from `accounts.auth_user_id` (never from a
   client-supplied UID).
5. When a player transfers guilds, their account's `guild` column follows
   them (`transfer_guild_member` / `resolve_guild_transfer`).

---

## 3. Database security model (CRITICAL)

### 3.1 Access-control helpers (use these, don't inline logic)

- `gm_can_read_guild_data(p_guild)` — SELECT policy qualifier for all
  tenant tables. `super_admin` → true; `guild_admin` → only own guild;
  `member`/anon → false.
- `gm_can_read_guilds()` — SELECT policy qualifier for the `guilds` table.
  `super_admin`/`guild_admin` → true; `member` → false (admins need the
  list for transfers).
- `check_user_guild_write_access(p_guild)` — INSERT/UPDATE/DELETE policy
  qualifier. `super_admin` → true everywhere; `guild_admin` → own guild;
  `member`/anon → false.
- `is_subscription_active(p_guild)` — write gating (Unlimited/Lifetime
  never expire; Premium checks the end date; super_admin exempt).
- `gm_can_admin_see_absences(p_guild)` — admin-only check for
  `player_absences`.

All of these are `SECURITY DEFINER`, `STABLE`, with `SET search_path TO ''`.
**Never create policies with inline `auth.jwt()` checks that reference
`accounts` directly — the `accounts` table is revoked for everyone, so the
policy would error with "permission denied for table accounts" for every
caller.** Always go through a SECURITY DEFINER helper.

### 3.2 RLS rules

- Every tenant table has RLS enabled. `accounts` and `guilds` too.
- Exactly **one** permissive SELECT policy per table is allowed. Multiple
  permissive policies combine with OR: a single stray legacy policy can
  re-open a hole. When replacing a policy, `DROP POLICY IF EXISTS` by the
  old name **and** any debug-named policies that may linger.
- INSERT/UPDATE/DELETE policies must use `check_user_guild_write_access`
  AND `is_subscription_active`.
- **Never grant EXECUTE to PUBLIC on functions.** Functions default to
  PUBLIC EXECUTE: a `REVOKE ... FROM anon` alone is NOT enough. Always:
  ```sql
  revoke all on function public.fn(...) from public, anon, authenticated;
  grant execute on function public.fn(...) to authenticated; -- if needed
  ```
- Never `GRANT SELECT` on tenant tables to `anon` (defense in depth, even
  though RLS would block).

### 3.3 Pitfalls learned the hard way (do not repeat)

1. **`CREATE OR REPLACE FUNCTION` keeps the same OID.** PostgREST can keep
   serving a cached plan of the old body (functions, policies, RLS).
   If a change "doesn't take effect", **rename the function** (new OID) and
   update callers — verified to be the reliable fix.
2. **`SET search_path TO ''` inside SECURITY DEFINER functions means
   unqualified table names resolve to nothing.** Always qualify
   `public.table` in every query inside these functions. An unqualified
   `FROM event_status` silently returns zero rows.
3. **Policies and functions live or die by the caller's role resolution.**
   `auth.uid()` works in RLS/RPC context; verify with a small test RPC
   before assuming.
4. **`accounts` has no public grants**: only its RLS policies + the
   `authenticated` SELECT grant (restored by migration
   `20260802270000_grant_accounts_select.sql`). If login can't read
   `accounts.guild`, the guild restriction never loads, and writes break
   for non-ALPHA admins (symptom: "Read-only access" or
   "`.eq is not a function`" — the read-only stub returned by the
   `db.from` wrapper).
5. After any schema/function/policy change, run:
   ```sql
   notify pgrst, 'reload schema';
   ```
   and test with a **fresh query shape** (PostgREST caches prepared plans).

---

## 4. Frontend conventions

- **Style**: ES5-style IIFEs, `var`, `function` declarations, no classes,
  no arrow functions in app code, no optional chaining where the codebase
  avoids it (match the surrounding file).
- **No comments** unless they explain a non-obvious security or
  compatibility decision (existing code has French comments — keep them,
  but new code should be in English).
- **UI language**: 100% English strings, via `i18n.js` (`t('key')`) for
  reusable strings; hardcoded English inline is acceptable for one-off
  messages but keep the style consistent.
- **No em-dashes** in UI text (project rule).
- **Escaping**: user-provided values rendered into HTML must go through
  `window.GM.escapeHTML()`.
- **Files**: `index.html` loads scripts in order; `gm-utils.js` first,
  `app.js` last (before `shell.js`). Cache-bust with `?v=N` and bump N on
  every change to that asset.
- **window.GM** exposes shared helpers (`login`, `logout`,
  `adminAccounts`, `registerPlayer`, `config.get/set`,
  `sendDiscordWebhook`, `canWriteGuild`, `ensureGuildRestriction`, ...).
  Add new shared helpers there, never duplicate logic.

### The `db.from` wrapper (gm-utils.js)

`gm-utils.js` wraps `db.from` to:
- auto-inject `guild` on insert/update/upsert/delete for the
  `tenantTables` list;
- gate mutations through `canWriteGuild` (returns a read-only stub
  `{ then }` when denied — **this is why `.eq()` chaining fails when
  blocked; that's by design**).

If you add a new tenant table, add it to `tenantTables`. If a table has no
`guild` column (like `guild_transfers`), it must NOT be added — filter
explicitly instead.

---

## 5. Backend conventions (Supabase)

- Migrations: `supabase/migrations/YYYYMMDDHHMMSS_name.sql`, one concern per
  migration, idempotent where possible (`if not exists`, `drop ... if
  exists`), always end with `notify pgrst, 'reload schema';`.
- Edge Functions: TypeScript/Deno, CORS headers, `json()` helper, identity
  resolved server-side via `auth.getUser()` + `accounts` lookup
  (never trust client-supplied IDs).
- Function config: `auth-login` and `member-portal` style functions that
  must be public use `--no-verify-jwt`; admin functions use JWT
  verification.
- Secrets go in Supabase Secrets / Vault — never in code, never in
  migrations.
- `accounts` table: passwords PGP-encrypted with the Vault key; shadow
  GoTrue users provisioned only by edge functions.

---

## 6. Testing — MANDATORY battery after EVERY change

**No change is complete until the full battery passes AND the affected
surface is regression-tested.** This is non-negotiable.

### 6.1 Unit tests (always)

```sh
npm install
npm test          # vitest run — all files, all must pass
npm run test:watch
```

Current suite: **114 tests** across `tests/` (i18n, roles, gm-utils,
utils, stats, shadowfront, cross-rank, subscription, player-register).
When you add a feature, **add unit tests for it** in the matching test
file (or a new `tests/<feature>.test.js`).

### 6.2 Security regression matrix (after ANY backend/security change)

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

Use `curl` against `https://<ref>.supabase.co/rest/v1/...` with a real
JWT (login via the `auth-login` edge function), like:
```sh
curl -s "https://$REF.supabase.co/rest/v1/guild_members?select=pseudo&guild=eq.ALPHA&limit=2" \
  -H "Authorization: Bearer $JWT" -H "apikey: $ANON_KEY"
```
Expect `[]` for members, data for admins, `403` on cross-tenant writes.

### 6.3 Anonymous (anon) surface scan (after ANY grant/function change)

```sql
-- functions executable by anon (must all be identity-checked or harmless)
select p.proname from pg_proc p
where has_function_privilege('anon', p.oid, 'EXECUTE');
-- tables with SELECT grants to anon (must be blocked by RLS)
select table_name from information_schema.role_table_grants
where grantee = 'anon' and privilege_type = 'SELECT';
```
Every anon-executable function must return `unauthorized`/empty without a
valid JWT. Every anon-granted table must return `[]` for anon.

### 6.4 End-to-end smoke (after ANY portal/edge-function change)

1. Register a player (join code + pending) → approve as admin → login.
2. Portal: dashboard loads, charts draw, Active Events submits scores,
   absence + timezone save, transfer request.
3. Reload the page → session survives (portal stays open).
4. Admin of a non-ALPHA guild: login, restriction loads, reads/writes own
   guild, cannot read ALPHA.

### 6.5 Check before every commit

- [ ] `npm test` — 114+ tests, all green
- [ ] No secret/token committed (`sbp_`, `vcp_`, `eyJ`, private keys)
- [ ] New UI strings are English, no em-dashes
- [ ] New tenant table added to `tenantTables` (or consciously excluded)
- [ ] New SQL uses `public.` qualification + `notify pgrst`
- [ ] New function: `revoke ... from public, anon, authenticated` +
      targeted grants
- [ ] Security matrix from 6.2 passes for the touched surface
- [ ] `?v=` cache busters bumped for changed assets
- [ ] CHANGELOG.md updated (if user-facing feature)

---

## 7. Deployment

- **Frontend**: push to `main` → Vercel auto-deploys.
- **Database**: `supabase db push` (apply pending migrations).
- **Edge functions**:
  ```sh
  supabase functions deploy <name> --no-verify-jwt   # public functions
  supabase functions deploy <name> --use-api         # JWT-verified
  ```
  Currently deployed: `auth-login`, `admin-accounts`, `member-portal`,
  `event-reminders`, `gm-create-order`, `gm-order-status`,
  `gm-revolut-webhook`, `player-register`.
- After `db push` or `functions deploy`, always run 6.2/6.3 on the live
  project.

---

## 8. Repository hygiene

- Only `main` branch exists; never create long-lived branches.
- Do not commit `.agents/`, `android/`, `apple-devices/`, build artifacts.
- Keep `CHANGELOG.md` current; `CHANGELOG-*.md` files are Discord-paste
  announcements (English, emoji shortcodes, no tables/HTML).
- The project is monetized (paid guild subscriptions). Treat any change
  to payments or access control as security-critical.
