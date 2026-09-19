# ADR-010: FORCE ROW LEVEL SECURITY Across All Public Tables

- **Status**: Accepted
- **Date**: 2026-09-20
- **Authors**: Lead Architect & SecOps

---

## 1. Context

In PostgreSQL, executing `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` enables row-level security for regular non-superuser roles. However, table owners (such as the `postgres` role in Supabase) and superusers bypass RLS policies by default unless `FORCE ROW LEVEL SECURITY` is explicitly declared.

During the comprehensive security audit (`[CONST-D6-01]`), 26 active public tables were identified as having `ENABLE ROW LEVEL SECURITY` active without `FORCE ROW LEVEL SECURITY`. In a multi-tenant SaaS architecture (`ALPHA`, `BABE`, `CLAW`, etc.), this created a risk where database procedures or extensions running with table owner privileges could inadvertently bypass tenant isolation boundaries.

## 2. Decision

We applied `ALTER TABLE public.<table_name> FORCE ROW LEVEL SECURITY;` across 100% of all 26 active public tables via migration `20260920100000_force_rls_all_tables.sql`:
`guilds`, `accounts`, `guild_members`, `event_status`, `event_participants`, `shadowfront_squads`, `shadowfront_signups`, `weekly_scores`, `sanctions`, `banned_players`, `guild_transfers`, `guild_config`, `player_absences`, `player_push_prefs`, `push_subscriptions`, `player_name_history`, `gm_payments`, `system_audit_logs`, `player_metrics_history`, `diplomatic_treaties`, `server_migration_groups`, `server_migration_group_servers`, `webauthn_challenges`, `account_passkeys`, `account_backup_codes`, `discord_verification_throttle`.

Additionally, any future table created in the schema (e.g. `public.ocr_cache`) must explicitly include both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

## 3. Consequences & Invariants

- **Zero-Bypass Policy**: Even table owners and superusers are constrained by RLS policies unless operating via explicit, audited `SECURITY DEFINER` functions with fixed `search_path = ''`.
- **Permanent Verification**: The automated test suite `tests/force_rls_coverage.test.js` inspects migration files and enforces that every newly created table has `FORCE ROW LEVEL SECURITY`.
