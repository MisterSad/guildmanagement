-- ==============================================================================
-- MIGRATION: 20260817203000_player_scores_and_metrics_tracking.sql
-- DESCRIPTION: 7-Score Military Metrics & Time-Series History Tracking
-- INVARIANTS: Multi-Tenant SaaS compliant, Zero-Trust RLS, Search Path Hardened
-- ==============================================================================

-- 1. Extend public.guild_members with the 6 tactical military score columns
ALTER TABLE public.guild_members
    ADD COLUMN IF NOT EXISTS tech_power BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS champion_power BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS crew_power BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS flagship_power BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fleet_rating BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS glory_score BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS metrics_updated_at TIMESTAMPTZ DEFAULT now();

-- 2. Create public.player_metrics_history for weekly time-series tracking
CREATE TABLE IF NOT EXISTS public.player_metrics_history (
    id BIGSERIAL PRIMARY KEY,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    pseudo TEXT NOT NULL,
    week_start DATE NOT NULL DEFAULT (date_trunc('week', CURRENT_DATE)::date),
    total_power BIGINT DEFAULT 0,
    tech_power BIGINT DEFAULT 0,
    champion_power BIGINT DEFAULT 0,
    crew_power BIGINT DEFAULT 0,
    flagship_power BIGINT DEFAULT 0,
    fleet_rating BIGINT DEFAULT 0,
    glory_score BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT player_metrics_history_guild_pseudo_week_key UNIQUE (guild, pseudo, week_start),
    CONSTRAINT fk_player_metrics_history_member FOREIGN KEY (guild, pseudo)
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Index for rapid timeline queries
CREATE INDEX IF NOT EXISTS idx_player_metrics_history_guild_pseudo_week
    ON public.player_metrics_history(guild, pseudo, week_start DESC);

-- 3. Row Level Security (RLS) for player_metrics_history
ALTER TABLE public.player_metrics_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "player_metrics_history_read" ON public.player_metrics_history;
CREATE POLICY "player_metrics_history_read"
    ON public.player_metrics_history
    FOR SELECT
    TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS "player_metrics_history_write" ON public.player_metrics_history;
CREATE POLICY "player_metrics_history_write"
    ON public.player_metrics_history
    FOR ALL
    TO authenticated
    USING (
        public.check_user_guild_write_access(guild)
        AND public.is_subscription_active(guild)
    )
    WITH CHECK (
        public.check_user_guild_write_access(guild)
        AND public.is_subscription_active(guild)
    );

-- 4. RPC: gm_upsert_player_metrics
-- Securely updates current metrics on guild_members and snapshots into player_metrics_history
CREATE OR REPLACE FUNCTION public.gm_upsert_player_metrics(
    p_guild text,
    p_pseudo text,
    p_total_power bigint DEFAULT NULL,
    p_tech_power bigint DEFAULT NULL,
    p_champion_power bigint DEFAULT NULL,
    p_crew_power bigint DEFAULT NULL,
    p_flagship_power bigint DEFAULT NULL,
    p_fleet_rating bigint DEFAULT NULL,
    p_glory_score bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_week_start date := (date_trunc('week', CURRENT_DATE)::date);
    v_tot bigint;
    v_tech bigint;
    v_champ bigint;
    v_crew bigint;
    v_flag bigint;
    v_fleet bigint;
    v_glory bigint;
BEGIN
    -- 1. Locate member
    SELECT pseudo, guild, overall_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score
    INTO v_member
    FROM public.guild_members
    WHERE guild = TRIM(p_guild) AND pseudo = TRIM(p_pseudo)
    LIMIT 1;

    IF v_member.pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    -- Resolve values (fallback to existing or 0)
    v_tot   := COALESCE(p_total_power, v_member.overall_power, 0);
    v_tech  := COALESCE(p_tech_power, v_member.tech_power, 0);
    v_champ := COALESCE(p_champion_power, v_member.champion_power, 0);
    v_crew  := COALESCE(p_crew_power, v_member.crew_power, 0);
    v_flag  := COALESCE(p_flagship_power, v_member.flagship_power, 0);
    v_fleet := COALESCE(p_fleet_rating, v_member.fleet_rating, 0);
    v_glory := COALESCE(p_glory_score, v_member.glory_score, 0);

    -- 2. Update guild_members row
    UPDATE public.guild_members
    SET overall_power      = v_tot,
        tech_power         = v_tech,
        champion_power     = v_champ,
        crew_power         = v_crew,
        flagship_power     = v_flag,
        fleet_rating       = v_fleet,
        glory_score        = v_glory,
        power_updated_at   = now(),
        metrics_updated_at = now()
    WHERE guild = v_member.guild AND pseudo = v_member.pseudo;

    -- 3. Upsert into player_metrics_history for current week
    INSERT INTO public.player_metrics_history (
        guild, pseudo, week_start,
        total_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score,
        created_at
    )
    VALUES (
        v_member.guild, v_member.pseudo, v_week_start,
        v_tot, v_tech, v_champ, v_crew, v_flag, v_fleet, v_glory,
        now()
    )
    ON CONFLICT (guild, pseudo, week_start)
    DO UPDATE SET
        total_power    = EXCLUDED.total_power,
        tech_power     = EXCLUDED.tech_power,
        champion_power = EXCLUDED.champion_power,
        crew_power     = EXCLUDED.crew_power,
        flagship_power = EXCLUDED.flagship_power,
        fleet_rating   = EXCLUDED.fleet_rating,
        glory_score    = EXCLUDED.glory_score,
        created_at     = now();

    RETURN jsonb_build_object(
        'ok', true,
        'guild', v_member.guild,
        'pseudo', v_member.pseudo,
        'total_power', v_tot,
        'tech_power', v_tech,
        'champion_power', v_champ,
        'crew_power', v_crew,
        'flagship_power', v_flag,
        'fleet_rating', v_fleet,
        'glory_score', v_glory
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_player_metrics(text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_metrics(text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint) TO authenticated;

-- 5. RPC: gm_get_player_metrics_history
-- Returns chronological history snapshots for player charts
CREATE OR REPLACE FUNCTION public.gm_get_player_metrics_history(
    p_uid text,
    p_limit int DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_history jsonb;
BEGIN
    SELECT pseudo, guild, uid
    INTO v_member
    FROM public.guild_members
    WHERE uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
    END IF;

    SELECT COALESCE(jsonb_agg(h ORDER BY h.week_start ASC), '[]'::jsonb)
    INTO v_history
    FROM (
        SELECT
            week_start,
            total_power,
            tech_power,
            champion_power,
            crew_power,
            flagship_power,
            fleet_rating,
            glory_score,
            created_at
        FROM public.player_metrics_history
        WHERE guild = v_member.guild AND pseudo = v_member.pseudo
        ORDER BY week_start DESC
        LIMIT LEAST(GREATEST(p_limit, 1), 52)
    ) h;

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_member.pseudo,
        'guild', v_member.guild,
        'history', v_history
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_player_metrics_history(text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_player_metrics_history(text, int) TO authenticated;

-- 6. Update gm_personal_kpis to return full metrics and calculated ratios
CREATE OR REPLACE FUNCTION public.gm_personal_kpis(p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_total_attended int := 0;
    v_total_sessions int := 0;
    v_rate numeric := 0;
    v_current_week date := (date_trunc('week', CURRENT_DATE)::date);
    v_density_index numeric := 0;
    v_combativity_index numeric := 0;
    v_residual_power bigint := 0;
BEGIN
    SELECT m.uid, m.pseudo, m.guild, m.overall_power, m.role, m.created_at,
           COALESCE(m.tech_power, 0) as tech_power,
           COALESCE(m.champion_power, 0) as champion_power,
           COALESCE(m.crew_power, 0) as crew_power,
           COALESCE(m.flagship_power, 0) as flagship_power,
           COALESCE(m.fleet_rating, 0) as fleet_rating,
           COALESCE(m.glory_score, 0) as glory_score,
           m.metrics_updated_at
    INTO v_member
    FROM public.guild_members m
    WHERE m.uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
    END IF;

    SELECT COUNT(DISTINCT public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text))
    INTO v_total_sessions
    FROM public.event_participants ep
    WHERE ep.guild = v_member.guild
      AND ep.week_start <= v_current_week
      AND LOWER(COALESCE(ep.event_name, '')) != 'glory'
      AND (ep.is_pending IS NOT TRUE);

    SELECT COUNT(DISTINCT public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text))
    INTO v_total_attended
    FROM public.event_participants ep
    WHERE ep.guild = v_member.guild
      AND ep.pseudo = v_member.pseudo
      AND ep.week_start <= v_current_week
      AND LOWER(COALESCE(ep.event_name, '')) != 'glory'
      AND (ep.is_pending IS NOT TRUE)
      AND (ep.participated > 0 OR ep.sub_present = true OR ep.score > 0 OR ep.score_prep > 0 OR ep.score_pvp > 0);

    IF v_total_sessions > 0 THEN
        v_rate := ROUND((v_total_attended::numeric / v_total_sessions::numeric) * 100, 1);
    END IF;

    -- Calculate derived indicators
    IF v_member.overall_power > 0 THEN
        v_density_index := ROUND(
            ((v_member.tech_power + v_member.champion_power + v_member.crew_power + v_member.flagship_power)::numeric / v_member.overall_power::numeric) * 100,
            1
        );
        v_combativity_index := ROUND(
            (v_member.glory_score::numeric / v_member.overall_power::numeric),
            2
        );
    END IF;

    v_residual_power := GREATEST(
        0,
        v_member.overall_power - (v_member.tech_power + v_member.champion_power + v_member.crew_power)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_member.pseudo,
        'guild', v_member.guild,
        'overall_power', v_member.overall_power,
        'tech_power', v_member.tech_power,
        'champion_power', v_member.champion_power,
        'crew_power', v_member.crew_power,
        'flagship_power', v_member.flagship_power,
        'fleet_rating', v_member.fleet_rating,
        'glory_score', v_member.glory_score,
        'metrics_updated_at', v_member.metrics_updated_at,
        'density_index', v_density_index,
        'combativity_index', v_combativity_index,
        'residual_power', v_residual_power,
        'role', v_member.role,
        'attended', v_total_attended,
        'total_sessions', v_total_sessions,
        'participation_rate', v_rate
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_personal_kpis(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_personal_kpis(text) TO authenticated;
