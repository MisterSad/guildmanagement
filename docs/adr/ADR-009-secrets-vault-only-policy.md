# ADR-009: Secrets Vault-Only Storage & Zero-Commit Rotation Policy

## Status
**Accepted** (2026-08-23)

## Context
A historical migration contained a hardcoded secret in a cron job URL parameter (`event-reminders-tick`), creating an immutable leak in git history and database dumps. Centralized, encrypted secrets management is required for all background services, cron hooks, and third-party integrations.

## Decision
1. **Vault-Only Secret Storage**:
   - Secrets are stored exclusively in Supabase Vault (`vault.decrypted_secrets`), managed via `vault.create_secret()` and accessed via Postgres `SECURITY DEFINER` wrapper functions.
   - Secrets must NEVER be committed to git, written into migration DDL, or exposed in client bundles.
2. **Coordinated Rotation Procedure**:
   - Generate cryptographically random secret (e.g. `openssl rand -hex 32`).
   - Upsert into `vault.decrypted_secrets` via SQL.
   - Synchronize Edge Function environment variable (`supabase secrets set KEY="<VALUE>"`).
   - Verify live endpoint acceptance of new credentials and rejection of old credentials via curl.
3. **Database Cron Wrappers**:
   - Cron jobs in `cron.job` call parameterless SQL functions (e.g. `public.gm_invoke_event_reminders()`) which read secrets securely from Vault within the database boundary.

## Invariants to Preserve
- Never include plain secret values in git commit messages, documentation, or public pull requests.
- Always revoke or rotate compromised credentials immediately upon detection.
