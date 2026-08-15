# ADR-003: Strict Multi-Tenant SaaS Invariants & Cross-Tenant Uniformity

## Status
**Accepted** (2026-08-12)

## Context
As FGF Guild Management expanded to support multiple guild tenants (`ALPHA`, `OMEGA`, `BABE`, `IMK`, `YARR`, `CLAW`, `DEMO`, `SEN`, `NIGHTWRAITH`, `OBSIDIANSTAR`, `ASTRAL_LIBERION`, `BLACKTHUNDER`, `TWILIGHT`), hardcoding guild-specific exceptions caused regressions across other guilds whenever a patch was made.

## Decision
1. **Zero Hardcoded Tenant Logic**:
   - No `if (guild === 'ALPHA')` or specific tenant branch in frontend or backend logic.
   - All tenant configurations (features, limits, webhooks, subscription status) are driven dynamically by the database (`public.guilds` and `public.guild_settings`).
2. **Tenant Scoping Enforcement**:
   - Write policies in Postgres enforce `check_user_guild_write_access(guild)` AND `is_subscription_active(guild)`.
   - Admin views dynamically scope queries using the verified tenant from the user session.

## Invariants to Preserve
- Any bug reported by a single guild must be fixed generically for all guilds.
- Every migration must maintain tenant isolation and compatibility across all registered tenants.
