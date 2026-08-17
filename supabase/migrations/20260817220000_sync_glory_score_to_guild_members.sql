-- ==============================================================================
-- MIGRATION: 20260817220000_sync_glory_score_to_guild_members.sql
-- DESCRIPTION: Synchronize latest recorded Glory score into guild_members
-- INVARIANTS: Multi-Tenant SaaS compliant, Zero-Trust RLS, Search Path Hardened
-- ==============================================================================

-- 1. Update gm_upsert_player_glory to update both event_participants and guild_members.glory_score
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
    v_safe_glory bigint := GREATEST(0, LEAST(500000000, COALESCE(p_glory, 0)));
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

    -- 1. Record / update weekly glory score in event_participants
    INSERT INTO public.event_participants (
        guild, event_name, session_id, week_start, pseudo, score, participated, created_at
    )
    VALUES (
        p_guild, 'Glory', v_session,
        p_week_start, p_pseudo, v_safe_glory::integer, 1, now()
    )
    ON CONFLICT (guild, event_name, session_id, pseudo) DO UPDATE SET
        score = EXCLUDED.score,
        participated = 1;

    -- 2. Update member tactical force metric glory_score in guild_members
    UPDATE public.guild_members
    SET glory_score = v_safe_glory,
        metrics_updated_at = now()
    WHERE guild = p_guild
      AND pseudo = p_pseudo;

    -- 3. Snapshot into player_metrics_history for weekly time-series
    INSERT INTO public.player_metrics_history (
        guild, pseudo, week_start, glory_score, created_at
    )
    VALUES (
        p_guild, p_pseudo, p_week_start, v_safe_glory, now()
    )
    ON CONFLICT (guild, pseudo, week_start) DO UPDATE SET
        glory_score = EXCLUDED.glory_score;

    -- 4. Clean up legacy un-sessioned duplicate if one exists
    DELETE FROM public.event_participants
    WHERE guild = p_guild
      AND event_name = 'Glory'
      AND week_start = p_week_start
      AND pseudo = p_pseudo
      AND session_id IS NULL;

    RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- Overload supporting text for p_week_start to ensure compatibility across all clients
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

-- 2. Backfill existing guild_members.glory_score from the latest recorded Sunday Glory in event_participants
WITH latest_glory AS (
    SELECT DISTINCT ON (guild, pseudo) guild, pseudo, score
    FROM public.event_participants
    WHERE event_name = 'Glory' AND score IS NOT NULL AND score > 0
    ORDER BY guild, pseudo, week_start DESC
)
UPDATE public.guild_members m
SET glory_score = lg.score,
    metrics_updated_at = now()
FROM latest_glory lg
WHERE m.guild = lg.guild
  AND m.pseudo = lg.pseudo
  AND (m.glory_score IS NULL OR m.glory_score = 0);

NOTIFY pgrst, 'reload schema';
