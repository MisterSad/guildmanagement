-- ============================================================================
-- Migration: 20260815234100_update_accounts_role_check_constraint.sql
-- Description: Update accounts_role_check constraint to permit 'server_admin'
-- ============================================================================

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('super_admin', 'server_admin', 'guild_admin', 'member', 'R5', 'R4', 'admin'));

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_guild_required;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_guild_required
  CHECK (role IN ('super_admin', 'server_admin') OR guild IS NOT NULL);

NOTIFY pgrst, 'reload schema';
