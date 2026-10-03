CREATE OR REPLACE FUNCTION public.gm_stats_weeks(p_guild text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_target text;
    v_weeks jsonb;
BEGIN
    v_target := nullif(btrim(p_guild), '');

    IF v_target IS NULL THEN
        SELECT nullif(btrim(a.guild), '') INTO v_target
        FROM public.accounts a
        WHERE a.auth_user_id = auth.uid()
        LIMIT 1;
    END IF;

    IF v_target IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_unresolved');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
    END IF;

    SELECT coalesce(jsonb_agg(w.week_start ORDER BY w.week_start DESC), '[]'::jsonb)
      INTO v_weeks
    FROM (
        SELECT DISTINCT ep.week_start
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
    ) w;

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'weeks', v_weeks);
END
$function$;

COMMENT ON FUNCTION public.gm_stats_weeks(text) IS
'Distinct event weeks for one tenant, newest first. Replaces list_event_weeks, dropped in 20260926140000 without the gm_* twin its own comment promised. Authorization is delegated to gm_can_read_guild_data (session validity, active status, role scoping) rather than re-read. Returns {ok, guild, weeks} or {ok:false, error}. No tenant fallback (ADR-003).';

REVOKE ALL ON FUNCTION public.gm_stats_weeks(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_stats_weeks(text) TO authenticated, service_role;

DO $verify$
BEGIN
    IF has_function_privilege('anon', 'public.gm_stats_weeks(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_weeks must not be callable by anon';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.gm_stats_weeks(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_weeks must be callable by authenticated';
    END IF;
    IF position('gm_can_read_guild_data' in pg_get_functiondef('public.gm_stats_weeks(text)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'gm_stats_weeks must delegate authorization, not re-read accounts.role';
    END IF;
    IF position('ALPHA' in pg_get_functiondef('public.gm_stats_weeks(text)'::regprocedure)) > 0 THEN
        RAISE EXCEPTION 'gm_stats_weeks must not name a tenant (ADR-003)';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
