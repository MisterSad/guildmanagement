-- Migration: Fix check_user_guild_access NULL fallback for legacy rows
CREATE OR REPLACE FUNCTION public.check_user_guild_access(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_guild text;
  v_effective_guild text;
BEGIN
  -- Fetch caller role and guild from accounts table
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Unauthenticated callers have no access
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Super Admin (R5) can access all guilds
  IF v_role = 'R5' THEN
    RETURN true;
  END IF;

  v_effective_guild := COALESCE(p_guild, 'ALPHA');
  RETURN v_guild = v_effective_guild OR v_guild IS NULL OR v_guild = 'ALL';
END;
$$;
