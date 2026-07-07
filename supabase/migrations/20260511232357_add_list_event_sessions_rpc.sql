CREATE OR REPLACE FUNCTION public.list_event_sessions()
RETURNS TABLE(
    event_name         text,
    session_id         text,
    week_start         date,
    participants       integer,
    participated_count integer,
    total_score        bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT
        event_name,
        session_id,
        week_start,
        COUNT(*)::integer AS participants,
        SUM(CASE WHEN participated > 0 THEN 1 ELSE 0 END)::integer AS participated_count,
        SUM(COALESCE(score, 0) + COALESCE(score_prep, 0) + COALESCE(score_pvp, 0))::bigint AS total_score
    FROM event_participants
    GROUP BY event_name, session_id, week_start
    ORDER BY COALESCE(session_id, week_start::text || 'T00:00:00.000Z') DESC;
$$;;
