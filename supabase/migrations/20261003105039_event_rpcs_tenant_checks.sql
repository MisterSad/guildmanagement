-- 20261003105039_event_rpcs_tenant_checks.sql
--
-- Event-roster RPCs that wrote into other guilds (audit 2026-10-03: SEC-04,
-- BE-B-02, BE-B-03). Measured on production before this migration:
--
--   gm_populate_event_participants_v2(p_guild, p_event_name, p_week_start)
--     No authorization at all, executable by `authenticated`: any signed-in
--     player could insert absent rows into any guild's sessions. It exists only
--     in production (its source survives in migrations_archive/) and has no
--     caller anywhere: app, Edge Functions, worker, SQL, cron, policies.
--     -> dropped, with gm_event_session_id, whose only caller it was.
--
--   gm_remove_member_from_active_events(p_pseudo, p_guild)
--     Refused only `member`; matched the caller by auth.uid() OR the JWT e-mail;
--     then deleted rows in whatever guild it was handed. No caller.
--     -> dropped.
--
--   gm_add_member_to_active_events(p_pseudo, p_guild)
--     Refused only `member`, so a JWT with no account (role NULL) passed, and a
--     guild_admin of A could enrol into B. Called by members.controller.ts.
--
--   gm_populate_event_participants(p_event_name, p_session_id, p_week_start, p_guild)
--     Bounded a guild_admin to their guild, but let server_admin and super_admin
--     reach every guild with no server check, never looked at `status`, and fell
--     back to the real tenant 'ALPHA' when the guild was missing. Its first step
--     is a DELETE. Called by EventsView and ArmsRaceView.
--
--   -> Both keep their production behaviour row for row. Only the gate changes:
--      a browser caller must pass check_user_guild_write_access(guild), the same
--      check every other guild-scoped write uses (active account, valid session,
--      own guild for guild_admin, own server for server_admin). A service-role
--      caller (no JWT) is trusted, as elsewhere. No 'ALPHA' fallback.
--
-- Why the add RPC is dropped and re-created rather than replaced: the
-- repository's original definition (20260812000003) declares the same
-- (text, text) signature with the parameters in the other order, and Postgres
-- refuses to rename parameters in place. Production uses (p_pseudo, p_guild),
-- which is what the client sends by name, so that is what is kept. The
-- repository's (p_guild, p_event_name, p_session_id, p_week_start) overload of
-- populate never reached production and is dropped where a replay created it.

-- ── 0. Refuse to rewrite a production body that changed since it was read ──

DO $pre$
DECLARE
  v_def  text;
  v_args text[];
BEGIN
  -- These guards pin production's bodies; an empty replay has the repository's.
  IF current_setting('gm.replay', true) = 'on' THEN RETURN; END IF;
  SELECT pg_get_functiondef(p.oid), p.proargnames INTO v_def, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'gm_add_member_to_active_events'
     AND oidvectortypes(p.proargtypes) = 'text, text';
  IF v_args = ARRAY['p_pseudo', 'p_guild']
     AND md5(v_def) <> 'fd86ca9512a4b9710a7f6fa24b7c74df'
     AND v_def !~ 'check_user_guild_write_access' THEN
    RAISE EXCEPTION 'gm_add_member_to_active_events changed since this migration was written; re-read it first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'gm_populate_event_participants'
     AND oidvectortypes(p.proargtypes) = 'text, text, date, text';
  IF v_def IS NOT NULL
     AND md5(v_def) <> '407d41e4a110ae48e8a11bfe195de6e3'
     AND v_def !~ 'check_user_guild_write_access' THEN
    RAISE EXCEPTION 'gm_populate_event_participants changed since this migration was written; re-read it first';
  END IF;
END
$pre$;

-- ── 1. Dead and unguarded: drop ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.gm_populate_event_participants_v2(text, text, date);
DROP FUNCTION IF EXISTS public.gm_event_session_id(text, date);
DROP FUNCTION IF EXISTS public.gm_remove_member_from_active_events(text, text);
DROP FUNCTION IF EXISTS public.gm_populate_event_participants(text, text, text, date);

-- ── 2. gm_add_member_to_active_events ────────────────────────────────────────

DROP FUNCTION IF EXISTS public.gm_add_member_to_active_events(text, text);

CREATE FUNCTION public.gm_add_member_to_active_events(p_pseudo text, p_guild text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_guild text;
  v_inserted integer;
BEGIN
  IF p_pseudo IS NULL OR p_pseudo = '' OR p_guild IS NULL OR p_guild = '' THEN
    RETURN 0;
  END IF;

  v_target_guild := UPPER(TRIM(p_guild));

  -- A browser must be allowed to write to this guild. A service-role caller
  -- (no JWT) is trusted: the Edge Function authenticated the user itself.
  IF auth.uid() IS NOT NULL AND NOT public.check_user_guild_write_access(v_target_guild) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.guild_members
    WHERE guild = v_target_guild AND LOWER(TRIM(pseudo)) = LOWER(TRIM(p_pseudo))
  ) THEN
    RETURN 0;
  END IF;

  WITH ins AS (
    INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score)
    SELECT
      v_target_guild,
      es.event_name,
      es.session_id,
      (DATE_TRUNC('week', COALESCE(es.start_at, es.updated_at) AT TIME ZONE 'UTC'))::date,
      gm.pseudo,
      0,
      null
    FROM public.event_status es
    CROSS JOIN public.guild_members gm
    WHERE es.guild = v_target_guild
      AND es.is_active = true
      AND es.session_id IS NOT NULL
      AND LOWER(es.event_name) NOT LIKE '%shadowfront%'
      AND gm.guild = v_target_guild
      AND LOWER(TRIM(gm.pseudo)) = LOWER(TRIM(p_pseudo))
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  RETURN COALESCE(v_inserted, 0);
END;
$$;

-- ── 3. gm_populate_event_participants ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_populate_event_participants(
  p_event_name text, p_session_id text, p_week_start date, p_guild text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inserted_count integer;
  v_target_guild text;
BEGIN
  IF p_event_name IS NULL OR p_session_id IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'event_name, session_id and week_start are required';
  END IF;

  -- No fallback guild: an unresolved tenant fails visibly.
  v_target_guild := UPPER(TRIM(p_guild));
  IF v_target_guild IS NULL OR v_target_guild = '' THEN
    RAISE EXCEPTION 'guild_required';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.check_user_guild_write_access(v_target_guild) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1. Remove unparticipated rows for pseudos no longer in this guild
  DELETE FROM public.event_participants ep
  WHERE ep.guild = v_target_guild
    AND ep.event_name = p_event_name
    AND ep.session_id = p_session_id
    AND COALESCE(ep.participated::text, '0') IN ('0', 'false')
    AND ep.score IS NULL
    AND COALESCE(ep.sub_present::text, '0') IN ('0', 'false')
    AND COALESCE(ep.appointed::text, '0') IN ('0', 'false')
    AND NOT EXISTS (
      SELECT 1 FROM public.guild_members gm
      WHERE gm.guild = v_target_guild
        AND LOWER(TRIM(gm.pseudo)) = LOWER(TRIM(ep.pseudo))
    );

  -- 2. Insert missing current guild members into the active event session
  WITH ins AS (
    INSERT INTO public.event_participants (guild, event_name, week_start, session_id, pseudo, participated, score)
    SELECT v_target_guild, p_event_name, p_week_start, p_session_id, gm.pseudo, 0, null
    FROM public.guild_members gm
    WHERE gm.guild = v_target_guild
      AND NOT EXISTS (
        SELECT 1 FROM public.event_participants ep
        WHERE ep.guild = v_target_guild
          AND ep.event_name = p_event_name
          AND ep.session_id = p_session_id
          AND LOWER(TRIM(ep.pseudo)) = LOWER(TRIM(gm.pseudo))
      )
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted_count FROM ins;

  RETURN COALESCE(inserted_count, 0);
END;
$$;

-- ── 4. Grants: signed-in browsers and the service role, nobody else ─────────

REVOKE ALL ON FUNCTION public.gm_add_member_to_active_events(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_add_member_to_active_events(text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.gm_populate_event_participants(text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_populate_event_participants(text, text, date, text) TO authenticated, service_role;

-- ── 5. Assert the end state ─────────────────────────────────────────────────

DO $check$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['gm_populate_event_participants_v2', 'gm_remove_member_from_active_events', 'gm_event_session_id'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = v_name) THEN
      RAISE EXCEPTION '% still exists', v_name;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('gm_populate_event_participants', 'gm_add_member_to_active_events')) <> 2 THEN
    RAISE EXCEPTION 'expected exactly one gm_populate_event_participants and one gm_add_member_to_active_events';
  END IF;

  IF pg_get_functiondef('public.gm_add_member_to_active_events(text, text)'::regprocedure) !~ 'check_user_guild_write_access\(v_target_guild\)'
     OR pg_get_functiondef('public.gm_populate_event_participants(text, text, date, text)'::regprocedure) !~ 'check_user_guild_write_access\(v_target_guild\)' THEN
    RAISE EXCEPTION 'an event RPC lost its tenant check';
  END IF;

  IF pg_get_functiondef('public.gm_populate_event_participants(text, text, date, text)'::regprocedure) ~ '''ALPHA''' THEN
    RAISE EXCEPTION 'gm_populate_event_participants still falls back to a real tenant';
  END IF;

  IF has_function_privilege('anon', 'public.gm_add_member_to_active_events(text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.gm_populate_event_participants(text, text, date, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.gm_add_member_to_active_events(text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.gm_populate_event_participants(text, text, date, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'unexpected grants on the event RPCs';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
