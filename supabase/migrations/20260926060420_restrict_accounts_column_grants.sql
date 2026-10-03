-- 20260926080000_restrict_accounts_column_grants.sql
-- AUDIT-2026-09-26 [C0 / CRITICAL]: `authenticated` held a table-wide
-- `GRANT SELECT ON public.accounts`, i.e. every column.
--
-- Combined with the `gm_accounts_select` policy (`USING gm_can_read_account(id)`),
-- which intentionally lets a `guild_admin` read every account of their own guild,
-- any guild admin could `GET /rest/v1/accounts?select=*` and exfiltrate, for
-- every member of their guild:
--   * password_hash      -- bcrypt, offline-crackable
--   * password_enc       -- pgp_sym_encrypt of the PLAINTEXT password
--   * gotrue_secret_enc  -- the shadow GoTrue password
--
-- Measured on production at audit time: 172/172 accounts carried a non-null
-- `password_enc`, and 98/172 had no bcrypt `password_hash` at all.
--
-- The original justification for the grant (`player_push_prefs` RLS subqueries
-- selecting `a.guild`, see 20260823100000_canonical_reconciliation_round2.sql:11)
-- only ever required column-level access.
--
-- This migration changes NO policy and NO function: RLS still decides *which
-- rows* a caller sees. It only narrows *which columns* PostgREST exposes.
-- `SECURITY DEFINER` functions are unaffected -- they execute as the function
-- owner and never consult these grants -- so `auth-login`, `admin-accounts`,
-- `member-portal` and every `gm_*` RPC keep working unchanged.
--
-- Column allowlist below is the union of:
--   a) columns read by RLS policy subqueries that run as the caller, verified
--      against pg_policies: id, auth_user_id, status, guild, role, uid
--      (ocr_cache_admin_select, player_absences_select_policy,
--       player_push_prefs_own/_write/_update, gm_migration_wiki_delete,
--       gm_migration_wiki_comments_delete)
--   b) columns selected by direct client PostgREST reads:
--      src/core/auth/roles.ts:196 and src/modules/app/auth/auth.controller.ts
--      :201/:218/:305/:323 -> guild, server_number
--      src/modules/app/admin/guild-requests.controller.ts:350
--        -> id, uid, status, role, guild, created_at
--
-- Deliberately withheld: password_hash, password_enc, gotrue_secret_enc,
-- failed_login_count, last_login_at, locked_until, session_version.
-- Verified: zero references to any of these seven anywhere in src/ outside the
-- generated type definitions.
--
-- NOTE: `anon` holds no privilege on public.accounts at all (verified), and
-- `authenticated` holds only SELECT (no INSERT/UPDATE/DELETE), so the direct
-- `from('accounts').update(...)` fallback at src/core/auth/session.ts:275 is
-- already unreachable today. This migration does not change that.

-- ============================================================================
-- 1. Replace the table-wide SELECT with an explicit column allowlist
-- ============================================================================

REVOKE SELECT ON public.accounts FROM authenticated;

GRANT SELECT (
    id,
    auth_user_id,
    status,
    guild,
    role,
    uid,
    server_number,
    created_at
) ON public.accounts TO authenticated;

COMMENT ON TABLE public.accounts IS
    'Credential store and source of truth for role resolution. '
    'authenticated holds COLUMN-LEVEL SELECT only (see migration '
    '20260926080000): password_hash, password_enc, gotrue_secret_enc, '
    'failed_login_count, last_login_at, locked_until and session_version are '
    'reachable exclusively via service_role and SECURITY DEFINER functions. '
    'Never widen this back to a table-wide GRANT.';

-- ============================================================================
-- 2. Reload the PostgREST schema cache so the new grants take effect at once
-- ============================================================================

NOTIFY pgrst, 'reload schema';

/* ============================================================================
   ROLLBACK SQL (restores the pre-audit, insecure state -- do not run unless a
   regression is traced to this migration):

   REVOKE SELECT ON public.accounts FROM authenticated;
   GRANT SELECT ON public.accounts TO authenticated;
   NOTIFY pgrst, 'reload schema';
   ============================================================================ */
