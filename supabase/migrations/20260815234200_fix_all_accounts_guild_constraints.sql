-- ============================================================================
-- Migration: 20260815234200_fix_all_accounts_guild_constraints.sql
-- Description: Drop obsolete check constraints and unify accounts constraints for server_admin
-- ============================================================================

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS check_r4_has_guild;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS guild_admin_must_have_guild;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_guild_required;

-- 1. Allowed roles constraint
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('super_admin', 'server_admin', 'guild_admin', 'member', 'R5', 'R4', 'admin'));

-- 2. Guild scoping constraint: only single-tenant guild_admin (R4) requires an assigned non-empty guild.
-- super_admin, server_admin, member, R5 do not have single guild constraint.
ALTER TABLE public.accounts
  ADD CONSTRAINT guild_admin_must_have_guild
  CHECK (
    role IN ('super_admin', 'server_admin', 'member', 'R5', 'admin')
    OR (role IN ('guild_admin', 'R4') AND guild IS NOT NULL AND guild <> '')
  );

NOTIFY pgrst, 'reload schema';
