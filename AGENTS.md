# AGENTS.md — Rules for AI agents working on this repository

## Persona
Lead Architect & SecOps. Zero-trust RBAC, strict tenant isolation. **All code, comments, types, UI strings, docs and tests are in English**; conversation with the owner is in French.

## Verification-first
Never claim completion without proof, and never fabricate a result. Measure against the running system rather than describing it from memory — the documentation in this repository was wrong about volumetrics by a factor of two, about which Edge Functions existed, and about what the database does on account deletion, for months at a time. See the `fgf-quality-gate` skill.

## Stack
- **Frontend**: TypeScript ES modules in `src/`, built by Vite. No UI framework. Modules call each other by typed import; the client (`setDbClient`/`getClient`) and the state (`app-state.ts`) are modules, not globals. The app installs exactly one global, the frozen `window.GM_E2E` the e2e suite drives (`tests/gm_bridge_contract.test.js` pins it); add nothing to `window`.
- **Backend**: Supabase Postgres 17 (RLS, `SECURITY DEFINER`, `SET search_path = ''`) + Deno Edge Functions. 13 deployed, 13 in the repo — keep it reconciled (ADR-017). Deploys run from CI only.
- **Hosting**: Vercel. No service worker behaviour, no PWA, no cookies, no analytics.
- **Scale** (measured 2026-11-06): 62 guilds, ~5,033 members, ~87,139 participation rows, 38 tables, 79 policies, 11 cron jobs. Re-measure rather than trust this line.

## Invariants that are easy to break
- **Four roles**: `super_admin`, `server_admin`, `guild_admin`, `member`. Resolved from `accounts` via `auth.uid()` — never from client-supplied data.
- **No per-tenant branching, and no hardcoded tenant list.** An unresolved tenant fails visibly; it never falls back to a real guild.
- **No inline style, anywhere.** The CSP has no `'unsafe-inline'` (`style-src 'self'`): a `style="..."` attribute, a `<style>` element or `setAttribute('style', …)` is refused by the browser and the element renders unstyled. Static styles are `u-*` classes in `utilities.css` (`legal.css` for the legal pages); a value computed at render time goes through `styleRef()` / `styleAttr()` (`src/core/dom/style-refs.ts`); `element.style.x = …` (CSSOM) is allowed. `tests/csp_strict.test.js` and the e2e fixture (any CSP violation fails the test) enforce it.
- **The guild TAG is a mutable tenant key** (ADR-022). A new column carrying a tag needs a `DEFERRABLE INITIALLY IMMEDIATE` FK (`ON UPDATE CASCADE` to `guilds`), or an entry in `gm_rename_guild`. `tests/guild_rename_migration.test.js` checks it against the regenerated types.
- **An event counts in the ISO week (Monday, UTC) of its start** (ADR-023). The database derives every `week_start` from `event_sessions`; never compute a week in the browser for a write, never end a session by nulling `event_status.start_at`, and start/end only through `gm_start_event_session` / `gm_end_event_session`.
- **`core/` never imports `modules/`.**
- **`src/core/state/app-state.ts` is the only writer** of cross-cutting state. Never assign `window.currentGuild` and friends directly.
- **The app is free** (ADR-015) and has **no PWA or push** (ADR-016). Do not reintroduce either, and do not document them.
- **`src/sw/service-worker.ts` is a tombstone that must keep shipping** until it has been live a full release cycle. Deleting it does not uninstall anything — read ADR-016 first.

## Security rules
1. **Secrets**: Vault / Deno env only. Never commit, never log, never print a secret — verify by digest or by an in-SQL boolean.
2. **Grants, not just policies.** A table-wide `GRANT SELECT` above correct policies is how credential columns leaked (finding C0). Grant columns.
3. **Zod-validate every Edge Function input.** Bound numbers.
4. **Never interpolate user input into an LLM prompt.**
5. **Webhooks**: resolved server-side from `guild_config`, never client-supplied. Discord hosts only.
6. **XSS**: one escaping boundary — `escapeHTML()` in `src/core/utils/text.ts`.
7. **Rate limits fail closed.**
8. **Never run a destructive probe against production.** `execute_sql` autocommits; this has permanently destroyed real rows. Test anything that writes on a replayed database (`scripts/replay-migrations.sh`, then `scripts/sql-tests.sh`). On production, a write runs only inside a dry run that ends in a raised exception, so the whole batch rolls back; read-only `SELECT`s are fine. There is no sandbox tenant: `DEMO` was removed on 2026-10-04.

## Quality gate
```bash
npm run lint           # Biome: lint + format check (biome.json); `npm run format` fixes the layout
npm run type-check     # 0 errors
npm test               # vitest run, all green, plus a coverage floor
npm run build
npx playwright test    # e2e, against the REAL built bundle in dist/
```
CI also runs, and so should you before touching SQL or an Edge Function:
- `deno check` + `deno test` on `supabase/functions/` (handlers run against `_test/fake-supabase.ts`);
- `scripts/replay-migrations.sh`, the schema fingerprint, then `scripts/sql-tests.sh` (RLS, grants and RPCs exercised as each role on a replayed Postgres 17 — `supabase/migrations/README.md`).

Prefer a test that RUNS the code over one that reads its text. A regex over the source is for guarding an absence (a flag, a URL), not a behaviour.
`event-reminders`, `member-portal`, `admin-accounts` and `auth-discord` are pinned by characterization snapshots (`scenarios.test.ts` + `__snapshots__/`): every response, database call, RPC and Discord post. A refactor keeps them green unchanged; regenerate them (`-- --update`) only for an intended behaviour change, and say so in the commit.
The e2e suite runs against `dist/` and is the only check that catches CSP violations and asset 404s. It is not optional.

## Skills
`.agents/skills/` — `fgf-quality-gate`, `fgf-rls-security`, `fgf-saas-architect`, `fgf-memory-keeper`, `fgf-changelog-discord`. Read `docs/adr/README.md` before any significant refactor.
