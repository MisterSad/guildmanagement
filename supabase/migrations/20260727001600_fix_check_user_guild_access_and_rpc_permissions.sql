-- Migration: 20260727001600_fix_check_user_guild_access_and_rpc_permissions.sql
-- Description: Guarantee check_user_guild_read_access permits authenticated users to read guild data and grant execute permissions on RPCs

CREATE OR REPLACE FUNCTION public.check_user_guild_read_access(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_guild text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_role IS NULL THEN
    IF auth.role() = 'authenticated' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  IF v_role = 'R5' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_guild, 'ALPHA') = p_guild;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_user_guild_write_access(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_guild text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_role IS NULL THEN
    IF auth.role() = 'authenticated' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  IF v_role = 'R5' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_guild, 'ALPHA') = p_guild;
END;
$$;

-- Grant EXECUTE permissions on RPCs to authenticated and anon roles
GRANT EXECUTE ON FUNCTION public.list_event_weeks(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.list_event_sessions(text) TO authenticated, anon;
