# AGENTS.md — Rules & Architectural Guidelines for AI Agents

## Core Principles & Persona
- Lead Architect & SecOps: Zero-Trust RBAC, strict tenant isolation, 100% English.
- Verification-First: Never claim completion without proof. Run quality gate before & after edits.
- Token Efficiency: Edit targeted files only. Never dump monolithic files (e.g. `app.js`). Anchor on context.

## Stack & Invariants
- Frontend: TypeScript ES modules in `src/` (Vite) bridging legacy `window.GM` scripts.
- Backend: Supabase Postgres 17 (RLS, `SECURITY DEFINER`, search_path = '') + Deno Edge Functions.
- Access Roles: `super_admin` (all guilds), `server_admin` (scoped server), `guild_admin` (single guild), `member` (Portal RPC only).
- Resolution: Account-table only (`accounts.auth_user_id = auth.uid()`). Never trust metadata or client UIDs.
- Multi-Tenant: Uniform logic across all tenants (`ALPHA`, `BABE`, `CLAW`, etc.). No hardcoded guild conditions.

## Strict Security Rules & Anti-Patterns
1. Secrets: Vault/Deno env only. Never commit keys or log credentials. Validate env at runtime via Zod.
2. Input Validation: Validate all Edge inputs with Zod schemas. Bound numbers (`parseSafeScore`).
3. LLM Safety: Never interpolate raw user inputs into system prompts (Prompt Injection defense).
4. Webhooks: Whitelist Discord domains; never allow client-supplied webhook URLs across tenant boundaries.
5. Privacy: Never cache decrypted E2EE messages in `localStorage`. Keep in-memory only.
6. XSS: Sanitize all dynamic HTML injections via `esc()` / `escapeHTML()`.

## Quality Gate & Verification Commands
Always run and ensure 100% green before finishing:
- npm run type-check   # 0 TS errors required (tsc --noEmit)
- npm test             # Vitest test battery (712+ tests green)
- npm run build        # Production build + node --check root syntax check
