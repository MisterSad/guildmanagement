# ADR-001: Three-Role Zero-Trust Access Model & Player Portal Isolation

## Status
**Accepted** (2026-08-12)

## Context
The platform serves multiple guilds and player roles. In earlier iterations, member roles risked querying database tables directly or relying on client-supplied identifiers in `localStorage`. This presented security risks of privilege escalation, cross-tenant data leakage, and unauthorized score tampering.

## Decision
1. **Three-Tier Partitioning**:
   - `super_admin`: Full read/write access across all guild tenants.
   - `guild_admin`: Scoped strictly to their own guild tenant.
   - `member`: **Zero direct database access**. Receives empty sets or permission denial on all Postgres tenant tables.
2. **Player Portal Isolation**:
   - The Player Portal communicates exclusively via the `member-portal` Supabase Edge Function (`service_role` execution).
   - Identity is cryptographically resolved from `accounts.auth_user_id` linked to the caller's JWT. Client-supplied UIDs are ignored.
3. **Defensive Score Bounding**:
   - Numerical scores submitted by players must pass server-side validation (`parseSafeScore`) bounded between `0` and `500_000_000`.

## Invariants to Preserve
- Never grant `member` roles direct SELECT/INSERT permissions on Postgres tenant tables.
- Never display admin views based synchronously on unverified `localStorage` state. Always gate routing on cryptographic session verification (`window.GM.sessionInfo()`).
