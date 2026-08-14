-- 20260810100000_update_gm_leaderboard_2w.sql
-- Update gm_leaderboard RPC to default to '1w' (current week) and support '2w' (2 weeks) period.

DROP FUNCTION IF EXISTS public.gm_leaderboard(text, text, text);
CREATE OR REPLACE FUNCTION public.gm_leaderboard(
  p_guild text DEFAULT NULL,
  p_period text DEFAULT '1w',
  p_week text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_caller_guild text;
  v_target_guild text;
  v_ref_week date;
  v_weeks date[];
  v_result jsonb;
BEGIN
  -- Authenticate caller role & target guild
  SELECT role, guild INTO v_caller_role, v_caller_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  IF v_caller_role = 'guild_admin' THEN
    v_target_guild := coalesce(v_caller_guild, 'ALPHA');
  ELSE
    v_target_guild := coalesce(upper(p_guild), coalesce(v_caller_guild, 'ALPHA'));
  END IF;

  -- Determine reference week (YYYY-MM-DD)
  IF p_week IS NOT NULL AND p_week <> '' THEN
    v_ref_week := p_week::date;
  ELSE
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC'))::date INTO v_ref_week;
  END IF;

  -- Determine affected weeks array
  IF p_period = '1w' THEN
    v_weeks := ARRAY[v_ref_week];
  ELSIF p_period = '2w' THEN
    SELECT array_agg(w.week_start ORDER BY w.week_start DESC) INTO v_weeks
    FROM (
      SELECT DISTINCT week_start
      FROM public.event_participants
      WHERE guild = v_target_guild AND week_start <= v_ref_week
      ORDER BY week_start DESC
      LIMIT 2
    ) w;
  ELSIF p_period = '4w' THEN
    SELECT array_agg(w.week_start ORDER BY w.week_start DESC) INTO v_weeks
    FROM (
      SELECT DISTINCT week_start
      FROM public.event_participants
      WHERE guild = v_target_guild AND week_start <= v_ref_week
      ORDER BY week_start DESC
      LIMIT 4
    ) w;
  ELSIF p_period = '8w' THEN
    SELECT array_agg(w.week_start ORDER BY w.week_start DESC) INTO v_weeks
    FROM (
      SELECT DISTINCT week_start
      FROM public.event_participants
      WHERE guild = v_target_guild AND week_start <= v_ref_week
      ORDER BY week_start DESC
      LIMIT 8
    ) w;
  ELSE
    -- 'all'
    SELECT array_agg(DISTINCT week_start ORDER BY week_start DESC) INTO v_weeks
    FROM public.event_participants
    WHERE guild = v_target_guild AND week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date;
  END IF;

  IF v_weeks IS NULL OR array_length(v_weeks, 1) IS NULL THEN
    v_weeks := ARRAY[v_ref_week];
  END IF;

  WITH guild_m AS (
    SELECT gm.pseudo, gm.uid
    FROM public.guild_members gm
    WHERE gm.guild = v_target_guild
  ),
  -- Unique non-Glory tenant event instances for the selected weeks
  tenant_events AS (
    SELECT DISTINCT
      public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text) AS ev_key
    FROM public.event_participants ep
    WHERE ep.guild = v_target_guild
      AND ep.is_pending = false
      AND lower(ep.event_name) <> 'glory'
      AND (p_period = 'all' OR ep.week_start = ANY(v_weeks))
      AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
  ),
  tot_events AS (
    SELECT count(*)::int AS total FROM tenant_events
  ),
  -- Player event attendance & performance
  player_events AS (
    SELECT
      lower(ep.pseudo) AS norm_pseudo,
      ep.pseudo,
      public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text) AS ev_key,
      upper(ep.event_name) AS event_name,
      (coalesce(ep.participated, 0) > 0 OR ep.sub_present = true OR coalesce(ep.score, 0) > 0 OR coalesce(ep.score_prep, 0) > 0 OR coalesce(ep.score_pvp, 0) > 0) AS attended,
      (coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0)) AS total_score
    FROM public.event_participants ep
    WHERE ep.guild = v_target_guild
      AND ep.is_pending = false
      AND lower(ep.event_name) <> 'glory'
      AND (p_period = 'all' OR ep.week_start = ANY(v_weeks))
      AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
  ),
  -- Group by member to compute distinct events attended
  member_event_agg AS (
    SELECT
      pe.norm_pseudo,
      count(DISTINCT pe.ev_key) FILTER (WHERE pe.attended) AS events_attended,
      sum(
        CASE
          WHEN pe.attended THEN
            (CASE
              WHEN pe.event_name LIKE '%SVS%' OR pe.event_name LIKE '%GVG%' THEN 30
              WHEN pe.event_name LIKE '%SHADOWFRONT%' THEN 18
              WHEN pe.event_name LIKE '%TRADE ROUTE%' OR pe.event_name LIKE '%DTR%' THEN 12
              ELSE 6
            END) +
            (CASE
              WHEN (pe.event_name LIKE '%SVS%' OR pe.event_name LIKE '%GVG%') AND pe.total_score > 0 THEN 20
              ELSE 0
            END)
          ELSE 0
        END
      ) AS events_score
    FROM player_events pe
    GROUP BY pe.norm_pseudo
  ),
  -- Glory progression deltas
  glory_rows AS (
    SELECT
      lower(ep.pseudo) AS norm_pseudo,
      ep.week_start,
      ep.score
    FROM public.event_participants ep
    WHERE ep.guild = v_target_guild
      AND lower(ep.event_name) = 'glory'
      AND coalesce(ep.score, 0) > 0
      AND (p_period = 'all' OR ep.week_start = ANY(v_weeks))
      AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
    ORDER BY ep.week_start ASC
  ),
  glory_deltas AS (
    SELECT
      gr.norm_pseudo,
      coalesce(sum(
        CASE WHEN gr.score > gr.prev_score THEN gr.score - gr.prev_score ELSE 0 END
      ), 0) AS glory_delta
    FROM (
      SELECT
        g.norm_pseudo,
        g.score,
        lag(g.score) OVER (PARTITION BY g.norm_pseudo ORDER BY g.week_start ASC) AS prev_score
      FROM glory_rows g
    ) gr
    WHERE gr.prev_score IS NOT NULL
    GROUP BY gr.norm_pseudo
  ),
  max_glory AS (
    SELECT max(glory_delta)::numeric AS max_delta FROM glory_deltas
  ),
  -- Final score assembly per member
  computed AS (
    SELECT
      gm.pseudo,
      gm.uid,
      coalesce(mea.events_score, 0)::numeric AS events_score,
      coalesce(mea.events_attended, 0)::int AS events_done,
      (SELECT total FROM tot_events)::int AS events_total,
      CASE
        WHEN (SELECT total FROM tot_events) > 0 THEN
          round((coalesce(mea.events_attended, 0)::numeric / (SELECT total FROM tot_events)), 4)
        ELSE 0
      END AS attendance_rate,
      coalesce(gd.glory_delta, 0)::int AS glory_delta,
      CASE
        WHEN coalesce((SELECT max_delta FROM max_glory), 0) > 0 AND coalesce(gd.glory_delta, 0) > 0 THEN
          round((gd.glory_delta::numeric / (SELECT max_delta FROM max_glory)) * 20 * GREATEST(1, array_length(v_weeks, 1)), 1)
        ELSE 0
      END AS glory_bonus,
      CASE
        WHEN (SELECT total FROM tot_events) > 0 AND (coalesce(mea.events_attended, 0)::numeric / (SELECT total FROM tot_events)) >= 0.80 THEN
          (15 * GREATEST(1, array_length(v_weeks, 1)))::numeric
        ELSE 0
      END AS consistency_bonus
    FROM guild_m gm
    LEFT JOIN member_event_agg mea ON mea.norm_pseudo = lower(gm.pseudo)
    LEFT JOIN glory_deltas gd ON gd.norm_pseudo = lower(gm.pseudo)
  )
  SELECT jsonb_build_object(
    'ok', true,
    'guild', v_target_guild,
    'period', p_period,
    'week', v_ref_week,
    'weeks_count', GREATEST(1, array_length(v_weeks, 1)),
    'scores', coalesce(jsonb_agg(
      jsonb_build_object(
        'pseudo', c.pseudo,
        'uid', c.uid,
        'score', round(c.events_score + c.glory_bonus + c.consistency_bonus, 1),
        'events_score', round(c.events_score, 1),
        'events_done', c.events_done,
        'events_total', c.events_total,
        'attendance_rate', c.attendance_rate,
        'glory_delta', c.glory_delta,
        'glory_bonus', c.glory_bonus,
        'consistency_bonus', c.consistency_bonus
      ) ORDER BY round(c.events_score + c.glory_bonus + c.consistency_bonus, 1) DESC, c.pseudo ASC
    ), '[]'::jsonb)
  ) INTO v_result
  FROM computed c;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_leaderboard(text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_leaderboard(text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
