-- gm_start_season_2 failed on production with "DELETE requires a WHERE clause".
--
-- Supabase preloads the pg_safeupdate module for the API role
-- (authenticator: session_preload_libraries = safeupdate), so every statement
-- an API request runs, including those inside a SECURITY DEFINER function,
-- must carry a WHERE clause when it deletes or updates. The eleven deletes of
-- gm_start_season_2 had none. The replay (plain postgres:17) does not load the
-- module, which is why supabase/tests/15_season_2.sql passed.
--
-- Same body, with an explicit WHERE true on each delete. Nothing else changes:
-- who may call it, the confirmation phrase, what is deleted and what is kept.

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
    -- "WHERE true": the API role runs under pg_safeupdate.
    DELETE FROM public.event_daily_scores WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_daily_scores', v_n);
    DELETE FROM public.war_sessions WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('war_sessions', v_n);
    DELETE FROM public.war_opponents WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('war_opponents', v_n);
    -- Every participation row, weekly Glory included.
    DELETE FROM public.event_participants WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_participants', v_n);
    DELETE FROM public.shadowfront_squads WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('shadowfront_squads', v_n);
    DELETE FROM public.shadowfront_signups WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('shadowfront_signups', v_n);
    DELETE FROM public.event_status WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_status', v_n);
    DELETE FROM public.event_sessions WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_sessions', v_n);
    DELETE FROM public.guild_weekly_snapshots WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('guild_weekly_snapshots', v_n);
    DELETE FROM public.player_metrics_history WHERE true;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('player_metrics_history', v_n);
    DELETE FROM public.weekly_scores WHERE true;
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

-- ── Assert the end state ────────────────────────────────────────────────────
-- No function in public may delete a whole table without a WHERE clause: under
-- pg_safeupdate it fails for every API caller. (Pattern kept out of comments.)

DO $check$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(DISTINCT p.proname, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosrc ~* 'delete\s+from\s+[a-z0-9_."]+\s*(;|returning)';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'unqualified delete (refused by pg_safeupdate) in: %', v_bad;
    END IF;
    IF (SELECT season FROM public.app_season WHERE id) IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'the app must still be in season 1 after this migration';
    END IF;
    IF has_function_privilege('anon', 'public.gm_start_season_2(text)', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.gm_start_season_2(text)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.gm_start_season_2(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'unexpected grants on gm_start_season_2';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
