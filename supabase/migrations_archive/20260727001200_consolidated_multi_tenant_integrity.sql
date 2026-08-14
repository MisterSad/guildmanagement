-- Migration: Consolidated Multi-Tenant Data Integrity & Strict Security Policies
-- 1. Fill all legacy NULL guild entries with 'ALPHA'
DO $$
BEGIN
    UPDATE public.guild_members SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.event_participants SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.event_status SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.shadowfront_squads SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.weekly_scores SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.sanctions SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.banned_players SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.shadowfront_signups SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.player_name_history SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.guild_config SET guild = 'ALPHA' WHERE guild IS NULL;
END $$;

-- 2. Enforce NOT NULL on guild columns without DEFAULT tenant fallback (prevents accidental fallback to ALPHA)
DO $$
BEGIN
    ALTER TABLE public.guild_members ALTER COLUMN guild SET NOT NULL;
    ALTER TABLE public.event_participants ALTER COLUMN guild SET NOT NULL;
    ALTER TABLE public.event_status ALTER COLUMN guild SET NOT NULL;
    ALTER TABLE public.shadowfront_squads ALTER COLUMN guild SET NOT NULL;
    ALTER TABLE public.weekly_scores ALTER COLUMN guild SET NOT NULL;
    ALTER TABLE public.sanctions ALTER COLUMN guild SET NOT NULL;
    ALTER TABLE public.banned_players ALTER COLUMN guild SET NOT NULL;

    -- Remove any legacy default tenant settings
    ALTER TABLE public.guild_members ALTER COLUMN guild DROP DEFAULT;
    ALTER TABLE public.event_participants ALTER COLUMN guild DROP DEFAULT;
    ALTER TABLE public.event_status ALTER COLUMN guild DROP DEFAULT;
    ALTER TABLE public.shadowfront_squads ALTER COLUMN guild DROP DEFAULT;
    ALTER TABLE public.weekly_scores ALTER COLUMN guild DROP DEFAULT;
    ALTER TABLE public.sanctions ALTER COLUMN guild DROP DEFAULT;
    ALTER TABLE public.banned_players ALTER COLUMN guild DROP DEFAULT;
EXCEPTION WHEN OTHERS THEN
    -- Ignore if already NOT NULL
    NULL;
END $$;

-- 3. Strict RLS Read Access Helper Function
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
  WHERE auth_user_id = auth.uid();

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Super Admin (R5) can read all guilds
  IF v_role = 'R5' THEN
    RETURN true;
  END IF;

  -- Guild Admin (R4) can only read their assigned guild
  RETURN COALESCE(v_guild, 'ALPHA') = p_guild;
END;
$$;

-- 4. Strict RLS Write Access Helper Function
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
  WHERE auth_user_id = auth.uid();

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Super Admin (R5) is base admin of ALPHA and can ONLY write to ALPHA
  IF v_role = 'R5' THEN
    RETURN p_guild = 'ALPHA';
  END IF;

  -- Guild Admin (R4) can only write to their assigned guild
  RETURN COALESCE(v_guild, 'ALPHA') = p_guild;
END;
$$;

-- 5. Update list_event_sessions RPC
CREATE OR REPLACE FUNCTION public.list_event_sessions(p_guild text DEFAULT NULL)
RETURNS TABLE(
    event_name         text,
    session_id         text,
    week_start         date,
    participants       integer,
    participated_count integer,
    total_score        bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
BEGIN
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_user_role IS NULL THEN
        RETURN;
    END IF;

    IF v_user_role = 'R4' THEN
        v_target_guild := COALESCE(v_user_guild, 'ALPHA');
    ELSE
        v_target_guild := COALESCE(p_guild, 'ALPHA');
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
$$;

-- 6. Update list_event_weeks RPC
CREATE OR REPLACE FUNCTION public.list_event_weeks(p_guild text DEFAULT NULL)
RETURNS TABLE(week_start date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
BEGIN
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_user_role IS NULL THEN
        RETURN;
    END IF;

    IF v_user_role = 'R4' THEN
        v_target_guild := COALESCE(v_user_guild, 'ALPHA');
    ELSE
        v_target_guild := COALESCE(p_guild, 'ALPHA');
    END IF;

    RETURN QUERY
    SELECT DISTINCT ep.week_start
    FROM public.event_participants ep
    WHERE ep.week_start IS NOT NULL
      AND ep.guild = v_target_guild
    ORDER BY ep.week_start DESC;
END;
$$;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
