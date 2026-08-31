-- 20260831010000_gm_get_player_event_history.sql
--
-- Admin-facing per-player event/attendance history — the counterpart to
-- gm_get_player_metrics_history (power/glory snapshots) for event
-- participation. The query logic mirrors member-portal's "get-history"
-- action (supabase/functions/member-portal/index.ts) — per-session player
-- score, guild average, guild max, and the late/excused/sub_present/
-- appointed flags — but that action is hard-locked to the caller's own
-- identity (uid read from the JWT, no target parameter). This RPC follows
-- the same "self OR in-scope admin" authorization model already proven by
-- gm_get_player_metrics_history, so it can be called for ANY player in an
-- admin's scope, not just the caller's own account.

CREATE OR REPLACE FUNCTION public.gm_get_player_event_history(p_uid text, p_limit int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_events jsonb;
BEGIN
    SELECT pseudo, guild INTO v_member
    FROM public.guild_members
    WHERE uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
    END IF;

    IF auth.uid() IS NOT NULL THEN
        IF NOT (
            public.is_super_admin() OR
            public.check_user_guild_access(v_member.guild) OR
            EXISTS (
                SELECT 1 FROM public.accounts a
                WHERE a.auth_user_id = auth.uid() AND (a.uid = p_uid OR a.id = p_uid) AND a.status = 'active'
            )
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    WITH guild_rows AS (
        SELECT
            UPPER(COALESCE(ep.event_name, '')) AS ev_key,
            COALESCE(ep.session_id, ep.week_start::text) AS sess_key,
            (COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0)) AS total_score,
            (ep.participated > 0 OR ep.sub_present = true) AS counted
        FROM public.event_participants ep
        WHERE ep.guild = v_member.guild
    ),
    session_stats AS (
        SELECT ev_key, sess_key,
               ROUND(AVG(total_score) FILTER (WHERE counted OR total_score > 0)) AS avg_score,
               MAX(total_score) AS max_score
        FROM guild_rows
        GROUP BY ev_key, sess_key
    ),
    member_rows AS (
        SELECT
            UPPER(COALESCE(ep.event_name, 'OTHER')) AS ev_key,
            ep.session_id,
            ep.week_start,
            COALESCE(ep.session_id, ep.week_start::text) AS sess_key,
            (ep.participated > 0) AS participated,
            (COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0)) AS player_score,
            COALESCE(ep.late, false) AS late,
            COALESCE(ep.excused, false) AS excused,
            COALESCE(ep.sub_present, false) AS sub_present,
            COALESCE(ep.appointed, false) AS appointed
        FROM public.event_participants ep
        WHERE ep.guild = v_member.guild AND ep.pseudo = v_member.pseudo
        ORDER BY ep.week_start DESC
        LIMIT LEAST(p_limit, 200)
    )
    SELECT jsonb_object_agg(t.ev_key, t.ev_data) INTO v_events
    FROM (
        SELECT
            mr.ev_key,
            jsonb_build_object(
                'count', COUNT(*),
                'attended', COUNT(*) FILTER (WHERE mr.participated OR mr.sub_present),
                'rate', CASE WHEN COUNT(*) > 0
                             THEN ROUND((COUNT(*) FILTER (WHERE mr.participated OR mr.sub_present))::numeric / COUNT(*)::numeric * 100)
                             ELSE 0 END,
                'history', jsonb_agg(
                    jsonb_build_object(
                        'session_id', mr.session_id,
                        'week_start', mr.week_start,
                        'participated', mr.participated,
                        'score', mr.player_score,
                        'guild_avg_score', COALESCE(ss.avg_score, 0),
                        'guild_max_score', COALESCE(ss.max_score, 0),
                        'late', mr.late,
                        'excused', mr.excused,
                        'sub_present', mr.sub_present,
                        'appointed', mr.appointed
                    ) ORDER BY mr.week_start DESC
                )
            ) AS ev_data
        FROM member_rows mr
        LEFT JOIN session_stats ss ON ss.ev_key = mr.ev_key AND ss.sess_key = mr.sess_key
        GROUP BY mr.ev_key
    ) t;

    RETURN jsonb_build_object(
        'ok', true,
        'guild', v_member.guild,
        'pseudo', v_member.pseudo,
        'events', COALESCE(v_events, '{}'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_player_event_history(text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_player_event_history(text, int) TO authenticated;

NOTIFY pgrst, 'reload schema';
