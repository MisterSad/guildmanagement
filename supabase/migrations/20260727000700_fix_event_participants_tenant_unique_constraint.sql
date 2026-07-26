-- Migration: Add tenant-aware UNIQUE constraints to event_participants and fix RPCs
-- 1. Ensure ON CONFLICT (guild, event_name, week_start, pseudo) works for Glory & non-session events
DO $$
BEGIN
    -- Drop single-tenant unique indexes if existing
    DROP INDEX IF EXISTS public.event_participants_no_session_unique;
    DROP INDEX IF EXISTS public.event_participants_session_unique;

    -- Deduplicate event_participants if duplicates exist before creating constraints
    DELETE FROM public.event_participants a
    USING public.event_participants b
    WHERE a.id < b.id
      AND COALESCE(a.guild, 'ALPHA') = COALESCE(b.guild, 'ALPHA')
      AND a.event_name = b.event_name
      AND a.week_start IS NOT DISTINCT FROM b.week_start
      AND a.session_id IS NOT DISTINCT FROM b.session_id
      AND a.pseudo = b.pseudo;

    -- Add UNIQUE constraint for no-session events (Glory)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'event_participants_guild_event_week_pseudo_key'
    ) THEN
        ALTER TABLE public.event_participants
            ADD CONSTRAINT event_participants_guild_event_week_pseudo_key UNIQUE (guild, event_name, week_start, pseudo);
    END IF;

    -- Add UNIQUE constraint for session events (SvS, GvG, DTR, Arms Race)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'event_participants_guild_event_session_pseudo_key'
    ) THEN
        ALTER TABLE public.event_participants
            ADD CONSTRAINT event_participants_guild_event_session_pseudo_key UNIQUE (guild, event_name, session_id, pseudo);
    END IF;
END $$;

-- 2. Update list_event_sessions RPC to include legacy NULL guild rows for ALPHA
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
        v_target_guild := v_user_guild;
    ELSE
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
    WHERE (v_target_guild IS NULL OR ep.guild = v_target_guild OR (COALESCE(v_target_guild, 'ALPHA') = 'ALPHA' AND ep.guild IS NULL))
    GROUP BY ep.event_name, ep.session_id, ep.week_start
    ORDER BY COALESCE(ep.session_id, ep.week_start::text || 'T00:00:00.000Z') DESC;
END;
$$;

-- 3. Update list_event_weeks RPC to include legacy NULL guild rows for ALPHA
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
        v_target_guild := v_user_guild;
    ELSE
        v_target_guild := p_guild;
    END IF;

    RETURN QUERY
    SELECT DISTINCT ep.week_start
    FROM public.event_participants ep
    WHERE ep.week_start IS NOT NULL
      AND (v_target_guild IS NULL OR ep.guild = v_target_guild OR (COALESCE(v_target_guild, 'ALPHA') = 'ALPHA' AND ep.guild IS NULL))
    ORDER BY ep.week_start DESC;
END;
$$;

-- 4. Fix guild_config RLS policy to use helper functions instead of JWT claim check
DROP POLICY IF EXISTS r4_manage_own ON public.guild_config;
DROP POLICY IF EXISTS r5_manage_all ON public.guild_config;

CREATE POLICY gm_guild_config_write ON public.guild_config FOR ALL TO authenticated
  USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
  WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
