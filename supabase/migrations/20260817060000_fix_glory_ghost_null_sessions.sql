-- 20260817060000_fix_glory_ghost_null_sessions.sql
--
-- Cross-Tenant Glory Data & Session Harmonization
-- 1. Deduplicates Glory rows in event_participants across all tenants:
--    Deletes un-sessioned (session_id IS NULL) rows where a sessioned row already exists.
-- 2. Backfills deterministic session_id ('GLORY-YYYY-Www') for any remaining un-sessioned Glory rows.
-- 3. Hardens gm_upsert_player_glory with write security checks, subscription checks, and automatic orphan cleanup.

-- 1. Delete un-sessioned duplicate ghost rows where a sessioned row exists
DELETE FROM public.event_participants ep_null
WHERE ep_null.event_name = 'Glory'
  AND ep_null.session_id IS NULL
  AND EXISTS (
      SELECT 1 FROM public.event_participants ep_sess
      WHERE ep_sess.guild = ep_null.guild
        AND ep_sess.event_name = 'Glory'
        AND ep_sess.week_start = ep_null.week_start
        AND ep_sess.pseudo = ep_null.pseudo
        AND ep_sess.session_id IS NOT NULL
  );

-- 2. Backfill deterministic session_id for surviving un-sessioned rows
UPDATE public.event_participants
SET session_id = 'GLORY-' || EXTRACT(isoyear FROM week_start) || '-W' || LPAD(EXTRACT(week FROM week_start)::text, 2, '0')
WHERE event_name = 'Glory'
  AND session_id IS NULL;

-- 3. Update gm_upsert_player_glory
CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
    p_guild text,
    p_pseudo text,
    p_week_start date,
    p_glory integer
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_session text;
BEGIN
    IF p_guild IS NULL OR p_pseudo IS NULL OR p_week_start IS NULL THEN
        RETURN QUERY SELECT false, 'missing_parameters';
        RETURN;
    END IF;

    IF NOT public.check_user_guild_write_access(p_guild) THEN
        RETURN QUERY SELECT false, 'permission_denied';
        RETURN;
    END IF;

    IF NOT public.is_subscription_active(p_guild) THEN
        RETURN QUERY SELECT false, 'subscription_expired';
        RETURN;
    END IF;

    v_session := 'GLORY-' || EXTRACT(isoyear FROM p_week_start) || '-W' || LPAD(EXTRACT(week FROM p_week_start)::text, 2, '0');

    INSERT INTO public.event_participants (
        guild, event_name, session_id, week_start, pseudo, score, participated, created_at
    )
    VALUES (
        p_guild, 'Glory', v_session,
        p_week_start, p_pseudo, p_glory, 1, now()
    )
    ON CONFLICT (guild, event_name, session_id, pseudo) DO UPDATE SET
        score = EXCLUDED.score,
        participated = 1;

    DELETE FROM public.event_participants
    WHERE guild = p_guild
      AND event_name = 'Glory'
      AND week_start = p_week_start
      AND pseudo = p_pseudo
      AND session_id IS NULL;

    RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- Overload supporting text for p_week_start to ensure compatibility with all clients
CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
    p_guild text,
    p_pseudo text,
    p_week_start text,
    p_glory integer
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    RETURN QUERY SELECT * FROM public.gm_upsert_player_glory(p_guild, p_pseudo, p_week_start::date, p_glory);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, date, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, date, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, text, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
