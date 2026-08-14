-- 20260811193000_fix_guild_config_dual_policy_and_search_path.sql
--
-- P0 FIX: guild_config has two permissive policies that both cover SELECT:
--   1. gm_authenticated_select (FOR SELECT)
--   2. gm_guild_config_write (FOR ALL — which includes SELECT)
-- Multiple permissive policies combine with OR, potentially widening access.
-- Fix: drop the FOR ALL policy and replace with separate INSERT/UPDATE/DELETE
-- policies using check_user_guild_write_access + is_subscription_active.
--
-- P1 FIX: Standardize is_subscription_active to use SET search_path TO ''
-- with fully qualified table names (was using SET search_path TO 'public').

-- ── 1. Fix guild_config dual policy (P0) ────────────────────────────────────

-- Drop the FOR ALL policy that was doubling as a SELECT policy
DROP POLICY IF EXISTS gm_guild_config_write ON public.guild_config;

-- Drop any legacy policies that may linger
DROP POLICY IF EXISTS gc_read ON public.guild_config;
DROP POLICY IF EXISTS gc_insert ON public.guild_config;
DROP POLICY IF EXISTS gc_update ON public.guild_config;
DROP POLICY IF EXISTS gc_delete ON public.guild_config;
DROP POLICY IF EXISTS r4_manage_own ON public.guild_config;
DROP POLICY IF EXISTS r5_manage_all ON public.guild_config;

-- Keep the existing SELECT policy (gm_authenticated_select) unchanged.
-- It uses gm_can_read_guild_data(guild) which allows super_admin + guild_admin.
-- Re-create it idempotently to be safe:
DROP POLICY IF EXISTS gm_authenticated_select ON public.guild_config;
CREATE POLICY gm_authenticated_select ON public.guild_config
  FOR SELECT TO authenticated
  USING (public.gm_can_read_guild_data(guild));

-- Create separate write policies (INSERT, UPDATE, DELETE)
CREATE POLICY gm_guild_config_insert ON public.guild_config
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_user_guild_write_access(guild)
    AND public.is_subscription_active(guild)
  );

CREATE POLICY gm_guild_config_update ON public.guild_config
  FOR UPDATE TO authenticated
  USING (
    public.check_user_guild_write_access(guild)
    AND public.is_subscription_active(guild)
  )
  WITH CHECK (
    public.check_user_guild_write_access(guild)
    AND public.is_subscription_active(guild)
  );

CREATE POLICY gm_guild_config_delete ON public.guild_config
  FOR DELETE TO authenticated
  USING (
    public.check_user_guild_write_access(guild)
    AND public.is_subscription_active(guild)
  );

-- ── 2. Standardize is_subscription_active (P1) ─────────────────────────────
-- Was using SET search_path TO 'public'; switch to SET search_path TO ''
-- with fully qualified names per AGENTS.md.

CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role text;
BEGIN
  -- Super Admin is never restricted by subscription expiration
  SELECT role INTO v_role
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Fallback: match by JWT sub when auth_user_id not synced
  IF v_role IS NULL THEN
    SELECT role INTO v_role
    FROM public.accounts
    WHERE auth_user_id::text = (auth.jwt()->>'sub');
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(
    (SELECT
       CASE
         WHEN subscription_type = 'Unlimited' OR subscription_type = 'Lifetime' THEN true
         WHEN subscription_type = 'Premium' AND subscription_end >= now() THEN true
         ELSE false
       END
     FROM public.guilds
     WHERE id = p_guild),
    true
  );
END;
$function$;

-- ── 3. Standardize list_event_sessions (P1) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_event_sessions(p_guild text DEFAULT NULL::text)
 RETURNS TABLE(event_name text, session_id text, week_start date, participants integer, participated_count integer, total_score bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
BEGIN
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_user_role IS NULL THEN
      SELECT role, guild INTO v_user_role, v_user_guild
      FROM public.accounts
      WHERE auth_user_id::text = (auth.jwt()->>'sub');
    END IF;

    IF v_user_role = 'guild_admin' THEN
        v_target_guild := COALESCE(v_user_guild, 'ALPHA');
    ELSE
        v_target_guild := COALESCE(p_guild, COALESCE(v_user_guild, 'ALPHA'));
    END IF;

    RETURN QUERY
    SELECT
        ep.event_name,
        ep.session_id,
        ep.week_start,
        COUNT(*)::integer AS participants,
        SUM(CASE WHEN ep.participated > 0 THEN 1 ELSE 0 END)::integer AS participated_count,
        SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0))::bigint AS total_score
    FROM public.event_participants ep
    WHERE ep.guild = v_target_guild
    GROUP BY ep.event_name, ep.session_id, ep.week_start
    ORDER BY COALESCE(ep.session_id, ep.week_start::text || 'T00:00:00.000Z') DESC;
END;
$function$;

-- ── 4. Standardize list_event_weeks (P1) ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_event_weeks(p_guild text DEFAULT NULL::text)
 RETURNS TABLE(week_start date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
BEGIN
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_user_role IS NULL THEN
      SELECT role, guild INTO v_user_role, v_user_guild
      FROM public.accounts
      WHERE auth_user_id::text = (auth.jwt()->>'sub');
    END IF;

    IF v_user_role = 'guild_admin' THEN
        v_target_guild := COALESCE(v_user_guild, 'ALPHA');
    ELSE
        v_target_guild := COALESCE(p_guild, COALESCE(v_user_guild, 'ALPHA'));
    END IF;

    RETURN QUERY
    SELECT DISTINCT ep.week_start
    FROM public.event_participants ep
    WHERE ep.week_start IS NOT NULL
      AND ep.guild = v_target_guild
    ORDER BY ep.week_start DESC;
END;
$function$;

-- ── 5. Standardize is_super_admin (P1) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE auth_user_id = auth.uid()
      AND role = 'super_admin'
  );
$function$;

NOTIFY pgrst, 'reload schema';
