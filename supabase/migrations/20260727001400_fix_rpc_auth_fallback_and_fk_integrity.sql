-- Migration: Fix RPC Auth Fallback and FK Multi-Tenant Integrity
-- 1. Fix list_event_sessions RPC fallback
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
    -- Fetch account info
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    -- Resolve target guild safely (fallback to p_guild or ALPHA if accounts row not linked)
    IF v_user_role = 'R4' THEN
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
$$;

-- 2. Fix list_event_weeks RPC fallback
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

    IF v_user_role = 'R4' THEN
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
$$;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
