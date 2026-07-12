-- Drop the parameterless versions of the functions to prevent conflict
DROP FUNCTION IF EXISTS public.list_event_sessions();
DROP FUNCTION IF EXISTS public.list_event_sessions(text);

DROP FUNCTION IF EXISTS public.list_event_weeks();
DROP FUNCTION IF EXISTS public.list_event_weeks(text);

-- 1. Create list_event_sessions with guild filtering
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
    -- Get user role and guild from accounts table
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    -- If not authenticated, return no data
    IF v_user_role IS NULL THEN
        RETURN;
    END IF;

    -- Enforce guild level security for R4
    IF v_user_role = 'R4' THEN
        v_target_guild := v_user_guild;
    ELSE
        -- R5 (Super Admin) can query any guild or all if p_guild is null
        v_target_guild := p_guild;
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
    WHERE (v_target_guild IS NULL OR ep.guild = v_target_guild)
    GROUP BY ep.event_name, ep.session_id, ep.week_start
    ORDER BY COALESCE(ep.session_id, ep.week_start::text || 'T00:00:00.000Z') DESC;
END;
$$;

-- 2. Create list_event_weeks with guild filtering
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
    -- Get user role and guild from accounts table
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    -- If not authenticated, return no data
    IF v_user_role IS NULL THEN
        RETURN;
    END IF;

    -- Enforce guild level security for R4
    IF v_user_role = 'R4' THEN
        v_target_guild := v_user_guild;
    ELSE
        -- R5 (Super Admin) can query any guild or all if p_guild is null
        v_target_guild := p_guild;
    END IF;

    RETURN QUERY
    SELECT DISTINCT ep.week_start
    FROM public.event_participants ep
    WHERE ep.week_start IS NOT NULL
      AND (v_target_guild IS NULL OR ep.guild = v_target_guild)
    ORDER BY ep.week_start DESC;
END;
$$;

-- 3. Setup privileges
REVOKE ALL ON FUNCTION public.list_event_sessions(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.list_event_weeks(text) FROM public, anon;

GRANT EXECUTE ON FUNCTION public.list_event_sessions(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_event_weeks(text) TO authenticated;
