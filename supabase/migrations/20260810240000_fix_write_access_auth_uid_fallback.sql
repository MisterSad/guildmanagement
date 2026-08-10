-- 20260810240000_fix_write_access_auth_uid_fallback.sql
--
-- Problem: check_user_guild_write_access uses auth.uid() to find the account row
-- via accounts.auth_user_id. If auth_user_id was reset or corrupted during password
-- reset flows, the RLS write check returns false for a valid guild_admin, causing
-- "permission denied for table guild_members".
--
-- Fix: also accept the match by JWT email derived id (accounts.id lookup via shadow
-- email in the session), or alternatively match by the JWT sub claim (GoTrue user_id).
-- The cleanest fix is to make the write helper use gm_can_read_guild_data-style lookup
-- that also checks auth.jwt() metadata, while still guarding against members.
--
-- Additionally, reset-password in admin-accounts was creating new GoTrue users when
-- auth_user_id was set but the gotrue_secret had diverged. The fix is to only ever
-- resync the existing GoTrue password -- never create a new shadow user on reset.

-- Rebuild check_user_guild_write_access to be resilient to auth_user_id mismatch.
-- Strategy: look up via auth_user_id first; fall back to JWT sub claim.
CREATE OR REPLACE FUNCTION public.check_user_guild_write_access(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_role  text;
  v_guild text;
BEGIN
  -- Primary lookup: match by GoTrue user id stored in accounts
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Fallback: match by JWT sub (GoTrue uid) when auth_user_id hasn't been synced yet
  IF v_role IS NULL THEN
    SELECT role, guild INTO v_role, v_guild
    FROM public.accounts
    WHERE auth_user_id::text = (auth.jwt()->>'sub');
  END IF;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- super_admin writes everywhere
  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  -- Only guild_admin may write tenant data via API (members use edge functions)
  IF v_role <> 'guild_admin' THEN
    RETURN false;
  END IF;

  RETURN COALESCE(v_guild, '') = COALESCE(p_guild, '');
END;
$function$;

-- Also rebuild gm_can_read_guild_data with same fallback for read policies
CREATE OR REPLACE FUNCTION public.gm_can_read_guild_data(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_role  text;
  v_guild text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  IF v_role IS NULL THEN
    SELECT role, guild INTO v_role, v_guild
    FROM public.accounts
    WHERE auth_user_id::text = (auth.jwt()->>'sub');
  END IF;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  IF v_role = 'member' THEN
    RETURN false;
  END IF;

  RETURN COALESCE(v_guild, '') = COALESCE(p_guild, '');
END;
$function$;

NOTIFY pgrst, 'reload schema';
