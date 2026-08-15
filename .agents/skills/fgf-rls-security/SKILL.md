---
name: fgf-rls-security
description: >-
  Zero-Trust access control, Postgres Row Level Security (RLS), and Supabase Edge Function security validator.
  Use when creating or modifying database tables, RLS policies, RPCs, Edge Functions, or authentication flows.
---

# FGF Zero-Trust & RLS Security Skill

## Access Control Hierarchy
- **`super_admin`**: Reads and writes all guild tenants. Bypasses tenant scoping. Sole account (HawkEye).
- **`guild_admin`**: Reads and writes ONLY their assigned guild tenant rows. Restricted to guild dashboard.
- **`member`**: ZERO direct database access. Receives `[]` or denial on all tenant tables and accounts (except own row). Queries exclusively through `member-portal` Edge Function.

## Golden Security Protocols
1. **SECURITY DEFINER Functions**:
   All database helper functions and RPCs must include:
   ```sql
   SECURITY DEFINER
   SET search_path TO ''
   ```
   Always use fully-qualified table references (e.g. `public.accounts`, `public.guilds`).

2. **Access Control Helpers**:
   - `public.gm_can_read_guild_data(p_guild text)`
   - `public.gm_can_read_guilds()`
   - `public.gm_can_read_account(p_account_id text)`
   - `public.check_user_guild_write_access(p_guild text)`
   - `public.is_subscription_active(p_guild text)`
   - `public.gm_can_admin_see_absences(p_guild text)`

3. **Public RPC Execution Revocation**:
   ```sql
   REVOKE ALL ON FUNCTION public.my_function(...) FROM public, anon;
   GRANT EXECUTE ON FUNCTION public.my_function(...) TO authenticated;
   ```

4. **Edge Function Security**:
   - Verify JWT and caller role using `supabase/functions/_shared/auth.ts`.
   - Never trust client-supplied user IDs or guild names; resolve them cryptographically from auth tokens.
   - Enforce SSRF whitelist (Discord official webhooks only) for webhook proxies.
