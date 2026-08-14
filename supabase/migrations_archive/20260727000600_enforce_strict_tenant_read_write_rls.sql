-- Migration: Strict Tenant Isolation and Read/Write RLS Rules
-- Rule 1: Guild Admins (R4) can only read and write to their assigned tenant.
-- Rule 2: Super Admins (R5) can read (visit) ALL tenants, but can ONLY write to tenant ALPHA.

-- 1. Helper function for Read Access
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
  -- Fetch caller role and guild from accounts table
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Unauthenticated callers have no access
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Super Admin (R5) can visit/read all guilds
  IF v_role = 'R5' THEN
    RETURN true;
  END IF;

  -- Guild Admin (R4) can only read their assigned guild
  RETURN COALESCE(v_guild, 'ALPHA') = COALESCE(p_guild, 'ALPHA');
END;
$$;

-- 2. Helper function for Write Access
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
  -- Fetch caller role and guild from accounts table
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Unauthenticated callers have no access
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Super Admin (R5) is base admin of ALPHA and can ONLY write to tenant ALPHA
  IF v_role = 'R5' THEN
    RETURN COALESCE(p_guild, 'ALPHA') = 'ALPHA';
  END IF;

  -- Guild Admin (R4) can only write to their assigned guild
  RETURN COALESCE(v_guild, 'ALPHA') = COALESCE(p_guild, 'ALPHA');
END;
$$;

-- 3. Apply strict RLS policies to all tenant tables
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'guild_members', 'event_participants', 'event_status',
    'shadowfront_squads', 'weekly_scores', 'sanctions', 'banned_players',
    'shadowfront_signups', 'player_name_history'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_select ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_insert ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_update ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_delete ON public.%I;', tbl);

    EXECUTE format('CREATE POLICY gm_authenticated_select ON public.%I FOR SELECT TO authenticated USING (public.check_user_guild_read_access(guild));', tbl);
    EXECUTE format('CREATE POLICY gm_authenticated_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));', tbl);
    EXECUTE format('CREATE POLICY gm_authenticated_update ON public.%I FOR UPDATE TO authenticated USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild)) WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));', tbl);
    EXECUTE format('CREATE POLICY gm_authenticated_delete ON public.%I FOR DELETE TO authenticated USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));', tbl);
  END LOOP;
END $$;

-- 4. Apply to guild_config
DROP POLICY IF EXISTS gm_authenticated_select ON public.guild_config;
DROP POLICY IF EXISTS r4_manage_own ON public.guild_config;
DROP POLICY IF EXISTS r5_manage_all ON public.guild_config;

CREATE POLICY gm_authenticated_select ON public.guild_config FOR SELECT TO authenticated
  USING (public.check_user_guild_read_access(guild));

CREATE POLICY r4_manage_own ON public.guild_config FOR ALL TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R4'
    AND public.check_user_guild_write_access(guild)
    AND public.is_subscription_active(guild)
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R4'
    AND public.check_user_guild_write_access(guild)
    AND public.is_subscription_active(guild)
  );

CREATE POLICY r5_manage_all ON public.guild_config FOR ALL TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata') ->> 'app_role') = 'R5'
    AND public.check_user_guild_write_access(guild)
  )
  WITH CHECK (
    ((auth.jwt() -> 'app_metadata') ->> 'app_role') = 'R5'
    AND public.check_user_guild_write_access(guild)
  );

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
