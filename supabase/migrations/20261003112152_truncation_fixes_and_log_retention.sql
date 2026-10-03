-- 20261003112152_truncation_fixes_and_log_retention.sql
--
-- Short-term plan, phase 1 (audit PERF-02, PERF-05, PERF-09, DB-16).
--
-- PostgREST answers at most 1,000 rows per request and says nothing when it
-- stops there. Two reads of whole-guild history crossed that line and turned
-- into wrong numbers on screen; both become one SQL aggregate here. The rest is
-- retention for tables that only ever grew.

-- ── 1. Guild averages for the sessions a player took part in (PERF-02) ──────
-- member-portal `get-history` read every participation row of the guild (up
-- to 9,859) to average scores per session. Above 1,000 rows the answer was an
-- arbitrary subset, so members of 14 guilds saw guild averages and maxima of 0
-- or simply wrong. Same counting rule as the TypeScript it replaces: a row
-- counts when it scored, participated, or came as a sub.
--
-- SECURITY INVOKER and service-role only: the Edge Function has already
-- authenticated the player and resolved their guild.

CREATE OR REPLACE FUNCTION public.gm_player_session_guild_stats(p_guild text, p_pseudo text)
RETURNS TABLE(session_key text, total_score bigint, counted integer, max_score bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH mine AS (
    SELECT DISTINCT
      UPPER(COALESCE(ep.event_name, '')) AS ev,
      COALESCE(NULLIF(ep.session_id, ''), ep.week_start::text, '') AS sk
    FROM public.event_participants ep
    WHERE ep.guild = p_guild AND ep.pseudo = p_pseudo
  ),
  rows AS (
    SELECT
      UPPER(COALESCE(ep.event_name, '')) AS ev,
      COALESCE(NULLIF(ep.session_id, ''), ep.week_start::text, '') AS sk,
      COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0) AS total,
      (COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0) > 0
        OR COALESCE(ep.participated, 0) > 0
        OR COALESCE(ep.sub_present, false)) AS counts
    FROM public.event_participants ep
    WHERE ep.guild = p_guild
  )
  SELECT
    r.ev || '|' || r.sk,
    COALESCE(SUM(r.total) FILTER (WHERE r.counts), 0)::bigint,
    (COUNT(*) FILTER (WHERE r.counts))::integer,
    COALESCE(MAX(r.total) FILTER (WHERE r.counts), 0)::bigint
  FROM rows r
  JOIN mine m ON m.ev = r.ev AND m.sk = r.sk
  GROUP BY r.ev, r.sk;
$$;

REVOKE ALL ON FUNCTION public.gm_player_session_guild_stats(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_player_session_guild_stats(text, text) TO service_role;

-- ── 2. Latest Glory score per player (PERF-05) ───────────────────────────────
-- The roster read the guild's whole Glory history (1,105 rows for one guild)
-- to keep the newest score of each player; past 1,000 rows the oldest fell
-- off. One row per player now. SECURITY INVOKER: the caller's RLS applies,
-- exactly as it did to the table read it replaces.

CREATE OR REPLACE FUNCTION public.gm_latest_glory_scores(p_guild text)
RETURNS TABLE(pseudo text, score bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT DISTINCT ON (LOWER(TRIM(ep.pseudo))) ep.pseudo, ep.score
  FROM public.event_participants ep
  WHERE ep.guild = p_guild
    AND ep.event_name = 'Glory'
    AND ep.score IS NOT NULL
  ORDER BY LOWER(TRIM(ep.pseudo)), ep.week_start DESC, ep.id DESC;
$$;

REVOKE ALL ON FUNCTION public.gm_latest_glory_scores(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_latest_glory_scores(text) TO authenticated, service_role;

-- ── 3. Ephemeral auth tables join the hourly purge (DB-16) ───────────────────
-- Expired WebAuthn challenges and Discord throttle windows were never deleted.
-- The throttle window is 10 minutes, so a day is far beyond any live one.

DO $pre$
BEGIN
  -- Pins production's body; an empty replay has the repository's.
  IF current_setting('gm.replay', true) = 'on' THEN RETURN; END IF;
  IF md5(pg_get_functiondef('public.gm_purge_discord_ephemera()'::regprocedure)) <> 'b9e4d1c8f6517eafcfd61f494556ec3e'
     AND pg_get_functiondef('public.gm_purge_discord_ephemera()'::regprocedure) !~ 'webauthn_challenges' THEN
    RAISE EXCEPTION 'gm_purge_discord_ephemera changed since this migration was written; re-read it first';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.gm_purge_discord_ephemera()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_states int; v_tickets int; v_codes int; v_links int; v_challenges int; v_throttle int;
BEGIN
    DELETE FROM public.discord_oauth_states WHERE expires_at <= now();
    GET DIAGNOSTICS v_states = ROW_COUNT;
    DELETE FROM public.discord_auth_tickets WHERE expires_at <= now();
    GET DIAGNOSTICS v_tickets = ROW_COUNT;
    DELETE FROM public.discord_link_codes WHERE expires_at <= now();
    GET DIAGNOSTICS v_codes = ROW_COUNT;
    -- Only expired AND unused: a redeemed code stays as evidence of who used
    -- it and when.
    DELETE FROM public.account_link_codes WHERE expires_at <= now() AND used_at IS NULL;
    GET DIAGNOSTICS v_links = ROW_COUNT;
    DELETE FROM public.webauthn_challenges WHERE expires_at <= now();
    GET DIAGNOSTICS v_challenges = ROW_COUNT;
    DELETE FROM public.discord_verification_throttle WHERE window_start < now() - interval '24 hours';
    GET DIAGNOSTICS v_throttle = ROW_COUNT;
    RETURN jsonb_build_object(
        'ok', true,
        'oauth_states_purged', v_states,
        'auth_tickets_purged', v_tickets,
        'link_codes_purged', v_codes,
        'account_link_codes_purged', v_links,
        'webauthn_challenges_purged', v_challenges,
        'verification_throttle_purged', v_throttle
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_purge_discord_ephemera() FROM PUBLIC, anon, authenticated;

-- ── 4. pg_cron's own run log (PERF-09) ───────────────────────────────────────
-- cron.job_run_details held every run since May: 209k rows, 93 MB, 57% of the
-- database. Two weeks is plenty to diagnose a failing job.

CREATE OR REPLACE FUNCTION public.gm_purge_cron_history()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted integer;
BEGIN
    DELETE FROM cron.job_run_details WHERE end_time < now() - interval '14 days';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_purge_cron_history() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-cron-history-purge') THEN
    PERFORM cron.unschedule('daily-cron-history-purge');
  END IF;
  PERFORM cron.schedule('daily-cron-history-purge', '50 4 * * *', 'SELECT public.gm_purge_cron_history();');
END
$cron$;

NOTIFY pgrst, 'reload schema';
