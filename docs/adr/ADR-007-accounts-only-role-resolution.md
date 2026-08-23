# ADR-007: Accounts-Only Role Resolution & JWT Metadata Deprecation

## Status
**Accepted** (2026-08-23)

## Context
Prior iterations included fallback logic in `public.is_super_admin()` and Edge Functions checking GoTrue `auth.jwt() -> 'user_metadata'` or `app_metadata` claims. Because `user_metadata` is writable by clients through Supabase client APIs, this introduced a severe privilege-escalation vulnerability where malicious actors could inject administrative roles.

## Decision
1. **Accounts Table as Sole Role SSOT**:
   - Role resolution is strictly grounded in `public.accounts` WHERE `auth_user_id = auth.uid()` AND `status = 'active'`.
   - `public.is_super_admin()` strictly queries `public.accounts` (SQL-level enforcement).
   - Privileged Edge Functions (`admin-accounts`, `member-portal`, `discord-webhook-proxy`, `ocr-guild-members`) resolve permissions from the `accounts` table or cryptographically verified shadow links, never client claims.
2. **Centralized Admin Matrix**:
   - Administrative endpoint permissions are verified via pure, unit-tested matrix `_shared/admin-authz.ts`.
3. **Role Drift Pre-Flight Audit**:
   - DevOps deployment runbooks must execute role drift queries comparing `auth.users` metadata against `public.accounts` prior to and following any infrastructure modification.

## Invariants to Preserve
- Never inspect `user_metadata` or `raw_user_meta_data` for authorization decisions in SQL or Edge Functions.
- Every active account must be mapped to an `auth.users` row with `status = 'active'`.
