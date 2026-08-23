# ADR-008: Database Migration Protocol v2 & Clean Replay Guarantees

## Status
**Accepted** (2026-08-23)

## Context
As migrations accumulated, differences in execution order between local clean replays and production live upgrades revealed subtle issues: missing `ON CONFLICT` arbiter indexes prior to table inserts, undeclared PL/pgSQL variable references, and missed PostgREST schema reloads.

## Decision
1. **Timestamped Forward-Only Migrations**:
   - Every database change is authored as a new, timestamped file in `supabase/migrations/YYYYMMDDHHMMSS_name.sql`.
   - Each migration file must end with explicit grant hygiene (`REVOKE ALL ON ... FROM public, anon;`, `GRANT EXECUTE ... TO authenticated;`) and `NOTIFY pgrst, 'reload schema';`.
   - Each migration file must embed a `-- ROLLBACK SQL` comment block documenting its inverse DDL.
2. **Deterministic Replay Order & Arbiter Indexes**:
   - `ON CONFLICT` arbiter unique indexes must always be created prior to any seeding or upsert operations targeting those tables.
   - Clean replay testing is supported via `supabase/replay/prelude.sql` (Supabase compatibility shims for pristine Postgres instances).
3. **Emergency Reconciliation Exception**:
   - Editing an already-applied migration file is strictly forbidden except when reconciling verified live database drift.
   - When this exception is used, the file must be immediately reapplied to the live database, verified, and documented with explicit rationale in the commit message.

## Invariants to Preserve
- Always use `CREATE OR REPLACE FUNCTION` and `ADD COLUMN IF NOT EXISTS` for zero-downtime safety.
- Always verify PL/pgSQL variable names against record field names (`SELECT ... INTO record_var`) before applying migrations.
