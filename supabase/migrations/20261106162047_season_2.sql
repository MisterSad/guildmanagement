-- Season 2 (owner decisions, 2026-11-06).
--
--   1. Every user sees a "Season 2 is coming soon" notice on every visit until
--      Season 2 starts.
--   2. Season 2 is started by ONE button that only the super admin can press.
--      It deletes the recorded data of EVERY guild: events and their history,
--      weekly Glory, weekly stats snapshots, power history and the SvS/GvG
--      opponent lists.
--   3. It keeps the players and their military stats (every guild_members
--      row and column: powers, current Glory), the chest-tier settings,
--      sanctions, absences, transfers and accounts.
--
-- The season lives in a one-row table; the app reads it through
-- gm_season_status() to decide whether to show the notice.

-- ── 1. The current season ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.app_season (
    id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
    season      smallint    NOT NULL DEFAULT 1 CHECK (season >= 1),
    started_at  timestamptz,
    started_by  text
);

INSERT INTO public.app_season (id, season) VALUES (true, 1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.app_season IS
    'The current game season, one row. Read through gm_season_status(); changed only by gm_start_season_2().';

ALTER TABLE public.app_season ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_season FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_season FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.app_season TO service_role;

-- Any signed-in user may know the season: it only decides whether the notice shows.
CREATE OR REPLACE FUNCTION public.gm_season_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object('season', s.season, 'started_at', s.started_at)
      FROM public.app_season s
     WHERE s.id
$$;

REVOKE ALL ON FUNCTION public.gm_season_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_season_status() TO authenticated, service_role;

-- ── 2. Starting Season 2 ────────────────────────────────────────────────────

-- A human act, on purpose: only a signed-in super admin, never the service
-- role, never twice, and only with the exact confirmation phrase. Everything
-- happens in this one transaction, or none of it.
CREATE OR REPLACE FUNCTION public.gm_start_season_2(p_confirm text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller text;
    v_season smallint;
    v_counts jsonb := '{}'::jsonb;
    v_n      integer;
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'gm_start_season_2: super_admin only' USING ERRCODE = '42501';
    END IF;
    IF p_confirm IS DISTINCT FROM 'START SEASON 2' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'confirmation_mismatch');
    END IF;

    SELECT s.season INTO v_season FROM public.app_season s WHERE s.id FOR UPDATE;
    IF v_season IS DISTINCT FROM 1 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_started', 'season', v_season);
    END IF;

    SELECT a.id INTO v_caller
      FROM public.accounts a
     WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    -- Children before parents: daily scores hang off war sessions.
    DELETE FROM public.event_daily_scores;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_daily_scores', v_n);
    DELETE FROM public.war_sessions;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('war_sessions', v_n);
    DELETE FROM public.war_opponents;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('war_opponents', v_n);
    -- Every participation row, weekly Glory included.
    DELETE FROM public.event_participants;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_participants', v_n);
    DELETE FROM public.shadowfront_squads;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('shadowfront_squads', v_n);
    DELETE FROM public.shadowfront_signups;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('shadowfront_signups', v_n);
    DELETE FROM public.event_status;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_status', v_n);
    DELETE FROM public.event_sessions;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_sessions', v_n);
    DELETE FROM public.guild_weekly_snapshots;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('guild_weekly_snapshots', v_n);
    DELETE FROM public.player_metrics_history;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('player_metrics_history', v_n);
    DELETE FROM public.weekly_scores;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('weekly_scores', v_n);

    UPDATE public.app_season
       SET season = 2, started_at = now(), started_by = v_caller
     WHERE id;

    INSERT INTO public.system_audit_logs (level, service, action_type, user_identifier, message, metadata, created_at)
    VALUES ('INFO', 'season', 'season_2_started', v_caller,
            'Season 2 started: every guild''s recorded data deleted; players and their stats kept',
            v_counts, now());

    RETURN jsonb_build_object('ok', true, 'season', 2, 'deleted', v_counts);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_start_season_2(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.gm_start_season_2(text) TO authenticated;

-- ── 3. Assert the end state ─────────────────────────────────────────────────

DO $check$
BEGIN
    IF (SELECT season FROM public.app_season WHERE id) IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'the app must still be in season 1 after this migration';
    END IF;
    IF has_table_privilege('authenticated', 'public.app_season', 'SELECT')
       OR has_table_privilege('anon', 'public.app_season', 'SELECT') THEN
        RAISE EXCEPTION 'app_season must be read through gm_season_status() only';
    END IF;
    IF has_function_privilege('anon', 'public.gm_start_season_2(text)', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.gm_start_season_2(text)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.gm_season_status()', 'EXECUTE') THEN
        RAISE EXCEPTION 'unexpected grants on the season functions';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
