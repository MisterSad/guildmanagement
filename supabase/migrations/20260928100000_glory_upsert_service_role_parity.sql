-- `/glory` has never saved anything, for any player, since 2026-08-17.
--
-- Measured on 2026-09-28 against the DEMO tenant, as a caller with
-- auth.uid() IS NULL -- which is exactly what an Edge Function or the Discord
-- worker is, since both authenticate with the service-role key and no user JWT:
--
--     SELECT public.check_user_guild_write_access('DEMO');   -> false
--     SELECT * FROM public.gm_upsert_player_metrics('DEMO', 'AbyssalLord', ...);
--                                                           -> ok = true
--     SELECT * FROM public.gm_upsert_player_glory('DEMO', 'AbyssalLord', ...);
--                                                           -> ok = false, permission_denied
--
-- Two sibling RPCs, called the same way by the same code, disagreeing. The
-- history explains it and is worth keeping:
--
--   * 20260812033000 (archived) made `check_user_guild_write_access` return
--     true for `service_role`, precisely because glory was answering
--     `permission_denied` to member-portal. Its header says so.
--   * The zero-trust hardening that followed rewrote that helper to return
--     false as soon as `auth.uid()` is NULL. That is the right behaviour for a
--     shared authorization helper -- a service-role caller has no user to
--     authorize, so the helper cannot answer the question it is asked.
--   * `gm_upsert_player_metrics` had meanwhile adopted the idiom that survives
--     it: gate only when there IS a JWT to gate.
--         IF auth.uid() IS NOT NULL THEN ... RAISE EXCEPTION 'forbidden'; END IF;
--   * `20260817060000_fix_glory_ghost_null_sessions.sql` re-declared
--     `gm_upsert_player_glory` calling the helper unconditionally, and nothing
--     failed loudly: the function returns `(ok, error)` rows instead of
--     raising, and every caller that mattered only inspected the transport
--     error. `/glory` reported a clean failure or, in the worker's case, a
--     success, and wrote nothing.
--
-- This migration gives glory the same gate its sibling has. Nothing is loosened
-- for a browser: an authenticated caller is still checked for guild write
-- access and an active subscription, exactly as today. A service-role caller --
-- discord-bot-interactions /glory, member-portal, the Discord worker -- stops
-- being refused for holding no user identity, which is the same trust model the
-- rest of the player-facing RPCs already run on: the Edge Function
-- authenticates the player and never accepts a caller-supplied guild.
--
-- The (text, text, text, bigint) overload is untouched: it delegates to this
-- one, so it inherits the fix.

CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
    p_guild text,
    p_pseudo text,
    p_week_start date,
    p_glory bigint
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_session text;
    v_safe_glory bigint := GREATEST(0, LEAST(9999999999, COALESCE(p_glory, 0)));
BEGIN
    IF p_guild IS NULL OR p_pseudo IS NULL OR p_week_start IS NULL THEN
        RETURN QUERY SELECT false, 'missing_parameters';
        RETURN;
    END IF;

    -- Internal authorization gate when called with an authenticated JWT, same
    -- idiom as gm_upsert_player_metrics. A service-role caller has no user to
    -- authorize; the Edge Function that holds that key authenticated the player
    -- before getting here and never accepts a caller-supplied guild.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.check_user_guild_write_access(p_guild) THEN
            RETURN QUERY SELECT false, 'permission_denied';
            RETURN;
        END IF;

        IF NOT public.is_subscription_active(p_guild) THEN
            RETURN QUERY SELECT false, 'subscription_expired';
            RETURN;
        END IF;
    END IF;

    v_session := 'GLORY-' || EXTRACT(isoyear FROM p_week_start) || '-W' || LPAD(EXTRACT(week FROM p_week_start)::text, 2, '0');

    -- 1. Record / update weekly glory score in event_participants
    INSERT INTO public.event_participants (
        guild, event_name, session_id, week_start, pseudo, score, participated, created_at
    )
    VALUES (
        p_guild, 'Glory', v_session,
        p_week_start, p_pseudo, v_safe_glory, 1, now()
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
$function$;

REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, date, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, date, bigint) TO authenticated, service_role;

COMMENT ON FUNCTION public.gm_upsert_player_glory(text, text, date, bigint) IS
'Upserts one player''s weekly Glory into event_participants, guild_members.glory_score and player_metrics_history. Authorization is gated only when auth.uid() IS NOT NULL, matching gm_upsert_player_metrics: a service-role caller (member-portal, discord-bot-interactions, the Discord worker) authenticated the player itself and never accepts a caller-supplied guild. Between 2026-08-17 and 2026-09-28 it called check_user_guild_write_access unconditionally, so every service-role save returned permission_denied and /glory silently saved nothing.';

DO $verify$
DECLARE
    v_src text;
BEGIN
    v_src := pg_get_functiondef('public.gm_upsert_player_glory(text, text, date, bigint)'::regprocedure);

    -- The gate must be conditional, or service-role callers are refused again.
    IF position('IF auth.uid() IS NOT NULL THEN' in v_src) = 0 THEN
        RAISE EXCEPTION 'gm_upsert_player_glory must gate only when there is a JWT to gate';
    END IF;

    -- ...and it must still be a gate for a browser.
    IF position('check_user_guild_write_access' in v_src) = 0 THEN
        RAISE EXCEPTION 'gm_upsert_player_glory must still check guild write access for an authenticated caller';
    END IF;

    IF has_function_privilege('anon', 'public.gm_upsert_player_glory(text, text, date, bigint)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_upsert_player_glory must not be reachable anonymously';
    END IF;
END
$verify$;

-- Reload the PostgREST schema cache so the new definition is served immediately.
NOTIFY pgrst, 'reload schema';
