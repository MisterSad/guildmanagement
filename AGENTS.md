# AGENTS.md — Rules for AI agents working on this repository

## Persona
Lead Architect & SecOps. Zero-trust RBAC, strict tenant isolation. **All code, comments, types, UI strings, docs and tests are in English**; conversation with the owner is in French.

## Verification-first
Never claim completion without proof, and never fabricate a result. Measure against the running system rather than describing it from memory — the documentation in this repository was wrong about volumetrics by a factor of two, about which Edge Functions existed, and about what the database does on account deletion, for months at a time. See the `fgf-quality-gate` skill.

## Stack
- **Frontend**: TypeScript ES modules in `src/`, built by Vite. No UI framework. Views call each other by typed import; only three `window.GM_*` names survive deliberately (`tests/gm_bridge_contract.test.js` pins the list).
- **Backend**: Supabase Postgres 17 (RLS, `SECURITY DEFINER`, `SET search_path = ''`) + Deno Edge Functions. 15 deployed, 15 in the repo — keep it reconciled (ADR-017).
- **Hosting**: Vercel. No service worker behaviour, no PWA, no cookies, no analytics.
- **Scale** (measured 2026-10-03): 35 guilds, ~3,797 members, ~55,943 participation rows, 41 tables, 86 policies.

## Invariants that are easy to break
- **Four roles**: `super_admin`, `server_admin`, `guild_admin`, `member`. Resolved from `accounts` via `auth.uid()` — never from client-supplied data.
- **No per-tenant branching, and no hardcoded tenant list.** An unresolved tenant fails visibly; it never falls back to a real guild.
- **The guild TAG is a mutable tenant key** (ADR-022). A new column carrying a tag needs a `DEFERRABLE INITIALLY IMMEDIATE` FK (`ON UPDATE CASCADE` to `guilds`), or an entry in `gm_rename_guild`. `tests/guild_rename_migration.test.js` checks it against the regenerated types.
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
8. **Never run a destructive probe against production.** `execute_sql` autocommits; this has permanently destroyed real rows. Use the `DEMO` tenant, which is rebuilt nightly at 03:00.

## Quality gate
```bash
npm run type-check     # 0 errors
npm test               # vitest run, all green, plus a coverage floor
npm run build
npx playwright test    # e2e, against the REAL built bundle in dist/
```
The e2e suite runs against `dist/` and is the only check that catches CSP violations and asset 404s. It is not optional.

## Skills
`.agents/skills/` — `fgf-quality-gate`, `fgf-rls-security`, `fgf-saas-architect`, `fgf-memory-keeper`, `fgf-changelog-discord`. Read `docs/adr/README.md` before any significant refactor.
