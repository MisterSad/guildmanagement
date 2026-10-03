-- Phase S1: give the Stats week selector a function that exists.
--
-- `StatsView.ts` calls `list_event_weeks`, which migration
-- 20260926140000_drop_dead_rpcs_and_diplomacy.sql dropped at line 73 as a
-- "legacy RPC superseded by a gm_* twin". No twin was ever written. Verified
-- against production on 2026-09-27: neither `list_event_weeks` nor
-- `gm_list_event_weeks` exists.
--
-- The failure is silent rather than loud. supabase-js answers a missing RPC
-- with { data: null, error } instead of throwing, and the call site never reads
-- `.error`, so `state.allWeeks` falls through to `[getWeekStart()]`. The week
-- dropdown has shown exactly one option ever since, and the 2w / 4w / 8w period
-- filters have all silently behaved as 1w, because they slice a one-element
-- array. ALPHA has 15 weeks of history the page could not reach.
--
-- Three deliberate departures from the function it replaces:
--
--   1. NO 'ALPHA' FALLBACK. `gm_stats_data` resolves an unknown tenant with
--      `coalesce(v_user_guild, 'ALPHA')`, twice. That is ADR-003 invariant #1,
--      and it means a super_admin whose guild is unresolved silently reads
--      another guild's data. Here an unresolved tenant is an error the caller
--      must handle. (`gm_stats_data`'s own fallback is phase S2.)
--
--   2. AUTHORIZATION IS DELEGATED to `gm_can_read_guild_data`, not rewritten.
--      The first draft of this function re-read `accounts.role` itself, the way
--      `gm_stats_data` does, and was weaker in three ways that only became
--      visible by reading the helper: it ignored `gm_session_is_valid()` (so a
--      revoked session still read data -- finding C1), it ignored
--      `status = 'active'` (so a suspended admin still read data -- finding
--      M14), and it let a server_admin pass any p_guild instead of scoping them
--      to their own server number. Re-implementing an authorization check is
--      how those three controls get silently dropped; the helper already has
--      all of them and no tenant fallback.
--
--   3. It returns an envelope, not a bare array, so "not authorized" and
--      "no weeks yet" stop being the same empty result.
--
-- Weeks are returned exactly as stored, not normalised to Monday. 14 rows out
-- of 55,739 carry a non-Monday `week_start` and produce 6 phantom weeks; that
-- is a data repair, and doing it here would desynchronise this list from the
-- raw `week_start` the client still filters on. It belongs with phase S3, when
-- the filtering itself moves into SQL.

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
    -- Resolve the target tenant only. Whether the caller may READ it is
    -- gm_can_read_guild_data's decision, below.
    v_target := nullif(btrim(p_guild), '');

    IF v_target IS NULL THEN
        -- No tenant asked for: use the caller's own, if they have one. This
        -- reads accounts for a value, never for a permission.
        SELECT nullif(btrim(a.guild), '') INTO v_target
        FROM public.accounts a
        WHERE a.auth_user_id = auth.uid()
        LIMIT 1;
    END IF;

    IF v_target IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_unresolved');
    END IF;

    -- Stats is an admin surface (owner decision, 2026-09-27); the helper denies
    -- `member` outright, pins a guild_admin to their own guild, scopes a
    -- server_admin to their server, and rejects a revoked or suspended session.
    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
    END IF;

    SELECT coalesce(jsonb_agg(w.week_start ORDER BY w.week_start DESC), '[]'::jsonb)
      INTO v_weeks
    FROM (
        SELECT DISTINCT ep.week_start
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          -- A week that has not started cannot have results. The client filters
          -- future weeks too; this keeps the list honest at the source.
          AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
    ) w;

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'weeks', v_weeks);
END
$function$;

COMMENT ON FUNCTION public.gm_stats_weeks(text) IS
'Distinct event weeks for one tenant, newest first. Replaces list_event_weeks, dropped in 20260926140000 without the gm_* twin its own comment promised. Returns an envelope: {ok, guild, weeks} or {ok:false, error}. No tenant fallback (ADR-003).';

REVOKE ALL ON FUNCTION public.gm_stats_weeks(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_stats_weeks(text) TO authenticated, service_role;

DO $verify$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_stats_weeks'
    ) THEN
        RAISE EXCEPTION 'gm_stats_weeks was not created';
    END IF;

    IF has_function_privilege('anon', 'public.gm_stats_weeks(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_weeks must not be callable by anon';
    END IF;

    IF NOT has_function_privilege('authenticated', 'public.gm_stats_weeks(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_weeks must be callable by authenticated';
    END IF;

    -- The whole point of this migration: the name the client calls must exist.
    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'list_event_weeks'
    ) THEN
        RAISE EXCEPTION 'list_event_weeks reappeared -- decide which one the client calls before shipping both';
    END IF;

    -- Delegation is the security property, so assert it rather than trusting
    -- that a later edit will remember why the body looks like this.
    IF position('gm_can_read_guild_data' in pg_get_functiondef('public.gm_stats_weeks(text)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'gm_stats_weeks must delegate authorization, not re-read accounts.role';
    END IF;

    IF position('ALPHA' in pg_get_functiondef('public.gm_stats_weeks(text)'::regprocedure)) > 0 THEN
        RAISE EXCEPTION 'gm_stats_weeks must not name a tenant (ADR-003)';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
