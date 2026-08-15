# ADR-004: Master DDL Consolidation & SECURITY DEFINER Protocol

## Status
**Accepted** (2026-08-12)

## Context
Over 158 incremental migration files made it difficult to audit schema consistency, track index changes, and ensure uniform RLS policies. Additionally, Postgres functions without explicit search paths presented security escalation risks.

## Decision
1. **4 Canonical Master DDL Files**:
   - `supabase/migrations/20260812000001_schema_tables_and_indexes.sql`
   - `supabase/migrations/20260812000002_security_rls_policies.sql`
   - `supabase/migrations/20260812000003_functions_and_rpcs.sql`
   - `supabase/migrations/20260812000004_triggers_and_crons.sql`
   - Legacy migrations archived under `supabase/migrations_archive/`. Dev seed data isolated under `supabase/seeds/dev_seed.sql`.
2. **SECURITY DEFINER Hardening**:
   - All `SECURITY DEFINER` functions must explicitly declare `SET search_path TO ''`.
   - All database object references within function bodies must be schema-qualified (e.g. `public.accounts`, `auth.users`).
   - Default `EXECUTE` privilege on internal RPCs is revoked from `public` and `anon`.

## Invariants to Preserve
- Never write `SECURITY DEFINER` functions without `SET search_path TO ''`.
- New database schema changes must be added to the canonical migrations or structured as clean incremental updates following the same security patterns.
