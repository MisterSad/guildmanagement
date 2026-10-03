-- Medium-term plan, phase M4a (audit ARC-02, DB-11, DB-12): every multi-step
-- write the browser used to issue as a sequence of table calls becomes ONE
-- SECURITY DEFINER function, so it either happens entirely or not at all.
--
-- Before this, each flow below was 2 to 6 separate requests with no rollback.
-- A failure half-way left the guild in a state no screen could produce:
--   * a ban recorded while the banned member stayed on the roster (the delete
--     error was silently skipped);
--   * a rename logged in player_name_history although the rename failed;
--   * a Shadowfront reschedule that moved the participants but not the squads
--     (four of its six writes never checked their error);
--   * a migration group created "open" with no servers;
--   * an OCR roster import applied for some rows and not others.
--
-- Owner decisions (2026-10-03), which change behaviour on purpose:
--   1. OCR roster import is all-or-nothing: one refused row and nothing is
--      written, and the officer is told which row.
--   2. Rescheduling SvS/GvG across a week now carries the war session and its
--      daily scores to the new session id. They used to stay behind on the old
--      id, orphaned from the event. fk_event_daily_scores_session gains ON
--      UPDATE CASCADE for that.
--   3. "Clear history" spares the sessions still running: active sessions,
--      their participants and their squads, and squads not yet started.
--
-- Authorization is the same rule the RLS write policies apply --
-- check_user_guild_write_access (which includes the session-epoch check) --
-- through one helper, and every statement is filtered on that guild: these
-- functions bypass RLS, so the filter IS the tenant boundary. They are for
-- browser sessions only: the service role has no write access to assert.

-- ── Shared guard ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_require_guild_write(p_guild text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := NULLIF(btrim(p_guild), '');
BEGIN
    IF v_guild IS NULL
       OR NOT public.check_user_guild_write_access(v_guild)
       OR NOT public.is_subscription_active(v_guild) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN v_guild;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_require_guild_write(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_require_guild_write(text) TO authenticated;

-- ── SvS/GvG daily scores follow their war session ─────────────────────────────

ALTER TABLE public.event_daily_scores DROP CONSTRAINT IF EXISTS fk_event_daily_scores_session;
ALTER TABLE public.event_daily_scores
    ADD CONSTRAINT fk_event_daily_scores_session
    FOREIGN KEY (guild, event_name, session_id)
    REFERENCES public.war_sessions (guild, event_name, session_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE;

-- ── Sessions: Events, Arms Race, Shadowfront ─────────────────────────────────

-- Moves a running session to a new start. The participants (and, for a
-- Shadowfront squad, its squad rows) follow to the new week; when the session
-- id changes they follow to the new id too, and so does an SvS/GvG war session
-- with its daily scores. The new id is the client's (buildEventSessionId):
-- it is a label, and the client already owns its format.
CREATE OR REPLACE FUNCTION public.gm_reschedule_event_session(
    p_guild text, p_event_name text, p_old_session_id text, p_new_session_id text, p_start_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := public.gm_require_guild_write(p_guild);
    v_event text := btrim(COALESCE(p_event_name, ''));
    v_old   text := NULLIF(btrim(p_old_session_id), '');
    v_new   text := NULLIF(btrim(p_new_session_id), '');
    v_sf    boolean;
    v_war   boolean;
    v_part  text;
    v_week  date;
BEGIN
    IF v_event = '' OR length(v_event) > 64 OR p_start_at IS NULL OR v_new IS NULL OR length(v_new) > 64 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    v_sf   := v_event ~ '^Shadowfront Squad [12]$';
    v_war  := v_event IN ('SvS', 'GvG');
    v_part := CASE WHEN v_sf THEN 'Shadowfront' ELSE v_event END;
    v_week := (date_trunc('week', p_start_at AT TIME ZONE 'UTC'))::date;

    UPDATE public.event_status SET start_at = p_start_at, updated_at = now()
     WHERE guild = v_guild AND event_name = v_event;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'no_session');
    END IF;

    IF v_sf THEN
        UPDATE public.shadowfront_squads SET week_start = v_week
         WHERE guild = v_guild AND session_id = v_old;
    END IF;
    UPDATE public.event_participants SET week_start = v_week
     WHERE guild = v_guild AND event_name = v_part AND session_id = v_old;
    IF v_war THEN
        UPDATE public.war_sessions SET start_at = p_start_at, updated_at = now()
         WHERE guild = v_guild AND event_name = v_event AND session_id = v_old;
    END IF;

    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.event_participants SET session_id = v_new
         WHERE guild = v_guild AND event_name = v_part AND session_id = v_old;
        IF v_sf THEN
            UPDATE public.shadowfront_squads SET session_id = v_new
             WHERE guild = v_guild AND session_id = v_old;
        END IF;
        UPDATE public.event_status SET session_id = v_new
         WHERE guild = v_guild AND event_name = v_event;
        IF v_war THEN
            -- event_daily_scores follows through fk_event_daily_scores_session.
            UPDATE public.war_sessions SET session_id = v_new, updated_at = now()
             WHERE guild = v_guild AND event_name = v_event AND session_id = v_old;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'session_id', v_new, 'week_start', v_week);
END;
$function$;

-- Deletes a session: its participants, a Shadowfront squad's squad rows, and
-- the event's status row. Same rows the three views deleted one by one.
CREATE OR REPLACE FUNCTION public.gm_delete_event_session(p_guild text, p_event_name text, p_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := public.gm_require_guild_write(p_guild);
    v_event text := btrim(COALESCE(p_event_name, ''));
    v_sid   text := NULLIF(btrim(p_session_id), '');
    v_sf    boolean;
    v_participants integer;
BEGIN
    IF v_event = '' OR length(v_event) > 64 OR length(COALESCE(v_sid, '')) > 64 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    v_sf := v_event ~ '^Shadowfront Squad [12]$';

    DELETE FROM public.event_participants
     WHERE guild = v_guild AND event_name = CASE WHEN v_sf THEN 'Shadowfront' ELSE v_event END
       AND session_id = v_sid;
    GET DIAGNOSTICS v_participants = ROW_COUNT;
    IF v_sf THEN
        DELETE FROM public.shadowfront_squads WHERE guild = v_guild AND session_id = v_sid;
    END IF;
    DELETE FROM public.event_status WHERE guild = v_guild AND event_name = v_event;

    RETURN jsonb_build_object('ok', true, 'participants', v_participants);
END;
$function$;

-- ── History ──────────────────────────────────────────────────────────────────

-- Clears a category's history (owner decision 3: running sessions are spared).
CREATE OR REPLACE FUNCTION public.gm_clear_event_history(p_guild text, p_event_names text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild  text := public.gm_require_guild_write(p_guild);
    v_active text[];
    v_participants integer;
    v_sessions integer;
BEGIN
    IF p_event_names IS NULL OR cardinality(p_event_names) NOT BETWEEN 1 AND 10 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    v_active := ARRAY(
        SELECT es.session_id FROM public.event_status es
         WHERE es.guild = v_guild AND es.event_name = ANY (p_event_names)
           AND es.is_active AND es.session_id IS NOT NULL);

    DELETE FROM public.event_participants
     WHERE guild = v_guild AND event_name = ANY (p_event_names)
       AND (session_id IS NULL OR NOT (session_id = ANY (v_active)));
    GET DIAGNOSTICS v_participants = ROW_COUNT;

    IF 'Shadowfront' = ANY (p_event_names) THEN
        -- Squads of finished sessions only: a squad with no session yet is a
        -- squad being prepared, not history.
        DELETE FROM public.shadowfront_squads
         WHERE guild = v_guild AND session_id IS NOT NULL AND NOT (session_id = ANY (v_active));
    END IF;

    DELETE FROM public.event_status
     WHERE guild = v_guild AND event_name = ANY (p_event_names) AND NOT is_active;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'participants', v_participants, 'sessions', v_sessions, 'spared', cardinality(v_active));
END;
$function$;

-- Deletes one session from the History detail dialog.
CREATE OR REPLACE FUNCTION public.gm_delete_history_session(
    p_guild text, p_event_name text, p_week_start date, p_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := public.gm_require_guild_write(p_guild);
    v_event text := btrim(COALESCE(p_event_name, ''));
    v_sid   text := NULLIF(btrim(p_session_id), '');
    v_participants integer;
BEGIN
    IF v_event = '' OR length(v_event) > 64 OR p_week_start IS NULL OR length(COALESCE(v_sid, '')) > 64 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    DELETE FROM public.event_participants
     WHERE guild = v_guild AND event_name = v_event AND week_start = p_week_start
       AND (session_id = v_sid OR (v_sid IS NULL AND session_id IS NULL));
    GET DIAGNOSTICS v_participants = ROW_COUNT;
    IF v_sid IS NOT NULL THEN
        IF v_event = 'Shadowfront' THEN
            DELETE FROM public.shadowfront_squads WHERE guild = v_guild AND session_id = v_sid;
        END IF;
        DELETE FROM public.event_status WHERE guild = v_guild AND session_id = v_sid;
    END IF;

    RETURN jsonb_build_object('ok', true, 'participants', v_participants);
END;
$function$;

-- ── Members ──────────────────────────────────────────────────────────────────

-- Bans a UID and removes it from the roster, together. The roster delete runs
-- the R5 guard trigger: banning an R5 now fails as a whole instead of leaving
-- the ban recorded and the member in place. The author is the caller's
-- account, never a value the browser sends.
CREATE OR REPLACE FUNCTION public.gm_ban_member(p_guild text, p_uid text, p_pseudo text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild   text := public.gm_require_guild_write(p_guild);
    v_uid     text := btrim(COALESCE(p_uid, ''));
    v_by      text;
    v_removed text;
BEGIN
    IF v_uid !~ '^[0-9]{6,10}$' OR length(COALESCE(p_pseudo, '')) > 64 OR length(COALESCE(p_reason, '')) > 500 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    SELECT a.id INTO v_by FROM public.accounts a WHERE a.auth_user_id = auth.uid() LIMIT 1;

    INSERT INTO public.banned_players (guild, uid, pseudo, reason, created_by)
    VALUES (v_guild, v_uid, NULLIF(btrim(p_pseudo), ''), NULLIF(btrim(p_reason), ''), COALESCE(v_by, 'Admin'))
    ON CONFLICT (guild, uid) DO NOTHING;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_banned');
    END IF;

    DELETE FROM public.guild_members WHERE guild = v_guild AND uid = v_uid
    RETURNING pseudo INTO v_removed;

    RETURN jsonb_build_object('ok', true, 'removed', v_removed);
END;
$function$;

-- Adds a member with its first metrics snapshot, and enrolls it in the
-- guild's running events, together. The UID and ban checks the form runs
-- first stay for their dialogs; the triggers (prevent_duplicate_member_uid,
-- gm_refuse_banned_member) are what actually refuse.
CREATE OR REPLACE FUNCTION public.gm_add_member(p_guild text, p_member jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild  text := public.gm_require_guild_write(p_guild);
    v_pseudo text := btrim(COALESCE(p_member->>'pseudo', ''));
    v_uid    text := btrim(COALESCE(p_member->>'uid', ''));
    v_role   text := COALESCE(NULLIF(p_member->>'role', ''), 'R1');
    v_power  bigint; v_fleet bigint; v_tech bigint; v_flag bigint; v_champ bigint; v_crew bigint; v_glory bigint;
    v_row    jsonb;
    v_added  integer;
    v_metrics jsonb;
BEGIN
    IF v_pseudo = '' OR length(v_pseudo) > 64 OR v_uid !~ '^[0-9]{6,10}$' OR v_role NOT IN ('R1', 'R2', 'R3', 'R4', 'R5') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    BEGIN
        v_power := COALESCE((p_member->>'overall_power')::bigint, 0);
        v_fleet := COALESCE((p_member->>'fleet_rating')::bigint, 0);
        v_tech  := COALESCE((p_member->>'tech_power')::bigint, 0);
        v_flag  := COALESCE((p_member->>'flagship_power')::bigint, 0);
        v_champ := COALESCE((p_member->>'champion_power')::bigint, 0);
        v_crew  := COALESCE((p_member->>'crew_power')::bigint, 0);
        v_glory := COALESCE((p_member->>'glory_score')::bigint, 0);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END;
    IF LEAST(v_power, v_fleet, v_tech, v_flag, v_champ, v_crew, v_glory) < 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    INSERT INTO public.guild_members AS m (guild, pseudo, uid, role, overall_power, fleet_rating, tech_power, flagship_power, champion_power, crew_power, glory_score)
    VALUES (v_guild, v_pseudo, v_uid, v_role, v_power, v_fleet, v_tech, v_flag, v_champ, v_crew, v_glory)
    RETURNING to_jsonb(m.*) INTO v_row;

    IF v_power <> 0 OR v_fleet <> 0 OR v_tech <> 0 OR v_flag <> 0 OR v_champ <> 0 OR v_crew <> 0 OR v_glory <> 0 THEN
        v_metrics := public.gm_upsert_player_metrics(v_guild, v_pseudo, v_power, v_tech, v_champ, v_crew, v_flag, v_fleet, v_glory);
        IF NOT COALESCE((v_metrics->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'metrics_failed: %', v_metrics->>'error';
        END IF;
    END IF;

    v_added := public.gm_add_member_to_active_events(v_pseudo, v_guild);

    RETURN jsonb_build_object('ok', true, 'member', v_row, 'added_events', v_added);
END;
$function$;

-- Updates a member: profile, metrics snapshot, this week's Glory, and the name
-- history row when the pseudo changes -- together. The history row used to be
-- written first and kept when the rename then failed. A pseudo change reaches
-- every child table through the (guild, pseudo) ON UPDATE CASCADE keys.
CREATE OR REPLACE FUNCTION public.gm_update_member(p_guild text, p_pseudo text, p_update jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := public.gm_require_guild_write(p_guild);
    v_old   public.guild_members%ROWTYPE;
    v_new   public.guild_members%ROWTYPE;
    v_by    text;
    v_res   jsonb;
    v_ok    boolean;
    v_err   text;
BEGIN
    IF p_update IS NULL OR jsonb_typeof(p_update) <> 'object' OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_update) k
         WHERE k NOT IN ('pseudo', 'uid', 'overall_power', 'role', 'tech_power', 'champion_power', 'crew_power',
                         'flagship_power', 'fleet_rating', 'glory_score', 'timezone', 'timezone_offset')) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    IF (p_update ? 'pseudo' AND (btrim(COALESCE(p_update->>'pseudo', '')) = '' OR length(p_update->>'pseudo') > 64))
       OR (p_update ? 'uid' AND COALESCE(btrim(p_update->>'uid'), '') <> '' AND btrim(p_update->>'uid') !~ '^[0-9]{6,10}$')
       OR (p_update ? 'role' AND p_update->>'role' NOT IN ('R1', 'R2', 'R3', 'R4', 'R5')) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    SELECT * INTO v_old FROM public.guild_members
     WHERE guild = v_guild AND pseudo = btrim(COALESCE(p_pseudo, '')) FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    BEGIN
        UPDATE public.guild_members m SET
            pseudo          = CASE WHEN p_update ? 'pseudo' THEN btrim(p_update->>'pseudo') ELSE m.pseudo END,
            uid             = CASE WHEN p_update ? 'uid' THEN NULLIF(btrim(p_update->>'uid'), '') ELSE m.uid END,
            role            = CASE WHEN p_update ? 'role' THEN p_update->>'role' ELSE m.role END,
            overall_power   = CASE WHEN p_update ? 'overall_power' THEN COALESCE((p_update->>'overall_power')::bigint, 0) ELSE m.overall_power END,
            tech_power      = CASE WHEN p_update ? 'tech_power' THEN COALESCE((p_update->>'tech_power')::bigint, 0) ELSE m.tech_power END,
            champion_power  = CASE WHEN p_update ? 'champion_power' THEN COALESCE((p_update->>'champion_power')::bigint, 0) ELSE m.champion_power END,
            crew_power      = CASE WHEN p_update ? 'crew_power' THEN COALESCE((p_update->>'crew_power')::bigint, 0) ELSE m.crew_power END,
            flagship_power  = CASE WHEN p_update ? 'flagship_power' THEN COALESCE((p_update->>'flagship_power')::bigint, 0) ELSE m.flagship_power END,
            fleet_rating    = CASE WHEN p_update ? 'fleet_rating' THEN COALESCE((p_update->>'fleet_rating')::bigint, 0) ELSE m.fleet_rating END,
            glory_score     = CASE WHEN p_update ? 'glory_score' THEN COALESCE((p_update->>'glory_score')::bigint, 0) ELSE m.glory_score END,
            timezone        = CASE WHEN p_update ? 'timezone' THEN NULLIF(p_update->>'timezone', '') ELSE m.timezone END,
            timezone_offset = CASE WHEN p_update ? 'timezone_offset' THEN (p_update->>'timezone_offset')::numeric ELSE m.timezone_offset END,
            power_updated_at   = now(),
            metrics_updated_at = now()
         WHERE m.id = v_old.id
        RETURNING m.* INTO v_new;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END;

    IF lower(v_new.pseudo) <> lower(v_old.pseudo) AND v_new.uid IS NOT NULL THEN
        SELECT a.id INTO v_by FROM public.accounts a WHERE a.auth_user_id = auth.uid() LIMIT 1;
        INSERT INTO public.player_name_history (guild, uid, old_pseudo, new_pseudo, changed_by)
        VALUES (v_guild, v_new.uid, v_old.pseudo, v_new.pseudo, COALESCE(v_by, 'Admin'));
    END IF;

    v_res := public.gm_upsert_player_metrics(v_guild, v_new.pseudo);
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'metrics_failed: %', v_res->>'error';
    END IF;

    -- A changed Glory is this week's Glory Tracker entry, as on the Glory page.
    IF p_update ? 'glory_score' AND v_new.glory_score IS DISTINCT FROM COALESCE(v_old.glory_score, 0) THEN
        SELECT g.ok, g.error INTO v_ok, v_err
          FROM public.gm_upsert_player_glory(v_guild, v_new.pseudo,
                 (date_trunc('week', now() AT TIME ZONE 'UTC'))::date, v_new.glory_score) g;
        IF NOT COALESCE(v_ok, false) THEN
            RAISE EXCEPTION 'glory_failed: %', v_err;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'pseudo', v_new.pseudo);
END;
$function$;

-- ── OCR ──────────────────────────────────────────────────────────────────────

-- Marks the players an OCR read as present in a session: the row is updated
-- when it exists and created otherwise, exactly as the browser did per row.
-- Each row may also set sub_present (a Shadowfront reserve) or appointed.
CREATE OR REPLACE FUNCTION public.gm_record_event_attendance(
    p_guild text, p_event_name text, p_session_id text, p_week_start date, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := public.gm_require_guild_write(p_guild);
    v_event text := btrim(COALESCE(p_event_name, ''));
    v_sid   text := NULLIF(btrim(p_session_id), '');
    r       jsonb;
    v_pseudo text;
    v_updated integer := 0;
    v_inserted integer := 0;
BEGIN
    IF v_event = '' OR length(v_event) > 64 OR v_sid IS NULL OR length(v_sid) > 64 OR p_week_start IS NULL
       OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 300 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
        v_pseudo := btrim(COALESCE(r->>'pseudo', ''));
        IF v_pseudo = '' THEN
            RAISE EXCEPTION 'bad_row: a row has no pseudo' USING ERRCODE = '22023';
        END IF;
        UPDATE public.event_participants p SET
            participated = 1,
            sub_present  = CASE WHEN COALESCE((r->>'sub_present')::boolean, false) THEN true ELSE p.sub_present END,
            appointed    = CASE WHEN COALESCE((r->>'appointed')::boolean, false) THEN true ELSE p.appointed END
         WHERE p.guild = v_guild AND p.event_name = v_event AND p.session_id = v_sid AND p.pseudo = v_pseudo;
        IF FOUND THEN
            v_updated := v_updated + 1;
        ELSE
            INSERT INTO public.event_participants (guild, event_name, session_id, pseudo, week_start, participated, sub_present, appointed)
            VALUES (v_guild, v_event, v_sid, v_pseudo, p_week_start, 1,
                    COALESCE((r->>'sub_present')::boolean, false), COALESCE((r->>'appointed')::boolean, false));
            v_inserted := v_inserted + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'updated', v_updated, 'inserted', v_inserted);
END;
$function$;

-- Applies an OCR roster import: one metric for existing members (and their
-- rank on a Members import), the new members, the removals -- all of them or
-- none (owner decision 1). A refused row raises, naming the row.
--   p_existing  [{pseudo, score, role?}]  role only for an R1-R4 rank read
--   p_new       [{pseudo, uid?, score, role?}]
--   p_removals  pseudos; an R5 is refused by its trigger
CREATE OR REPLACE FUNCTION public.gm_commit_ocr_roster(
    p_guild text, p_field text, p_existing jsonb, p_new jsonb, p_removals text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild   text := public.gm_require_guild_write(p_guild);
    v_week    date := (date_trunc('week', now() AT TIME ZONE 'UTC'))::date;
    r         jsonb;
    v_pseudo  text;
    v_score   bigint;
    v_role    text;
    v_current text;
    v_uid     text;
    v_res     jsonb;
    v_ok      boolean;
    v_err     text;
    v_updated integer := 0;
    v_added   integer := 0;
    v_removed integer := 0;
    v_ranks   integer := 0;
BEGIN
    IF p_field NOT IN ('overall_power', 'fleet_rating', 'tech_power', 'flagship_power', 'champion_power', 'crew_power', 'glory_score')
       OR jsonb_typeof(COALESCE(p_existing, '[]')) <> 'array' OR jsonb_typeof(COALESCE(p_new, '[]')) <> 'array'
       OR jsonb_array_length(COALESCE(p_existing, '[]')) > 500 OR jsonb_array_length(COALESCE(p_new, '[]')) > 500
       OR cardinality(COALESCE(p_removals, '{}')) > 500 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_existing, '[]')) LOOP
        v_pseudo := btrim(COALESCE(r->>'pseudo', ''));
        v_score  := GREATEST(0, COALESCE((r->>'score')::bigint, 0));
        v_role   := NULLIF(r->>'role', '');
        IF v_role IS NOT NULL AND v_role NOT IN ('R1', 'R2', 'R3', 'R4') THEN
            RAISE EXCEPTION 'row_refused: % (rank %)', v_pseudo, v_role USING ERRCODE = '22023';
        END IF;
        SELECT m.role INTO v_current FROM public.guild_members m WHERE m.guild = v_guild AND m.pseudo = v_pseudo FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'row_refused: % (not in the roster)', v_pseudo USING ERRCODE = '22023';
        END IF;
        IF v_current = 'R5' THEN v_role := NULL; END IF;

        IF p_field = 'glory_score' THEN
            SELECT g.ok, g.error INTO v_ok, v_err FROM public.gm_upsert_player_glory(v_guild, v_pseudo, v_week, v_score) g;
            IF NOT COALESCE(v_ok, false) THEN
                RAISE EXCEPTION 'row_refused: % (%)', v_pseudo, v_err;
            END IF;
        ELSE
            EXECUTE format(
                'UPDATE public.guild_members SET %I = $1, metrics_updated_at = now()%s%s WHERE guild = $2 AND pseudo = $3',
                p_field,
                CASE WHEN p_field = 'overall_power' THEN ', power_updated_at = now()' ELSE '' END,
                CASE WHEN v_role IS NOT NULL THEN ', role = $4' ELSE '' END)
            USING v_score, v_guild, v_pseudo, v_role;
            IF v_role IS NOT NULL AND v_role IS DISTINCT FROM v_current THEN v_ranks := v_ranks + 1; END IF;
        END IF;

        v_res := public.gm_upsert_player_metrics(v_guild, v_pseudo);
        IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'row_refused: % (%)', v_pseudo, v_res->>'error';
        END IF;
        v_updated := v_updated + 1;
    END LOOP;

    FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_new, '[]')) LOOP
        v_pseudo := btrim(COALESCE(r->>'pseudo', ''));
        v_score  := GREATEST(0, COALESCE((r->>'score')::bigint, 0));
        v_role   := COALESCE(NULLIF(r->>'role', ''), 'R1');
        v_uid    := NULLIF(btrim(COALESCE(r->>'uid', '')), '');
        IF v_pseudo = '' OR length(v_pseudo) > 64 OR (v_uid IS NOT NULL AND v_uid !~ '^[0-9]{6,10}$') THEN
            RAISE EXCEPTION 'row_refused: % (invalid pseudo or UID)', v_pseudo USING ERRCODE = '22023';
        END IF;
        IF v_role NOT IN ('R1', 'R2', 'R3', 'R4') THEN v_role := 'R1'; END IF;
        v_uid := COALESCE(v_uid, 'TEMP-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8));

        BEGIN
            INSERT INTO public.guild_members (guild, pseudo, uid, role, overall_power, fleet_rating, tech_power, flagship_power, champion_power, crew_power, glory_score)
            VALUES (v_guild, v_pseudo, v_uid, v_role,
                    CASE WHEN p_field = 'overall_power' THEN v_score ELSE 0 END,
                    CASE WHEN p_field = 'fleet_rating' THEN v_score ELSE 0 END,
                    CASE WHEN p_field = 'tech_power' THEN v_score ELSE 0 END,
                    CASE WHEN p_field = 'flagship_power' THEN v_score ELSE 0 END,
                    CASE WHEN p_field = 'champion_power' THEN v_score ELSE 0 END,
                    CASE WHEN p_field = 'crew_power' THEN v_score ELSE 0 END,
                    CASE WHEN p_field = 'glory_score' THEN v_score ELSE 0 END);
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'row_refused: % (%)', v_pseudo, SQLERRM USING ERRCODE = '22023';
        END;
        IF v_role <> 'R1' THEN v_ranks := v_ranks + 1; END IF;

        IF p_field = 'glory_score' AND v_score > 0 THEN
            SELECT g.ok, g.error INTO v_ok, v_err FROM public.gm_upsert_player_glory(v_guild, v_pseudo, v_week, v_score) g;
            IF NOT COALESCE(v_ok, false) THEN
                RAISE EXCEPTION 'row_refused: % (%)', v_pseudo, v_err;
            END IF;
        END IF;
        v_res := public.gm_upsert_player_metrics(v_guild, v_pseudo);
        IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'row_refused: % (%)', v_pseudo, v_res->>'error';
        END IF;
        v_added := v_added + 1;
    END LOOP;

    IF cardinality(COALESCE(p_removals, '{}')) > 0 THEN
        BEGIN
            DELETE FROM public.guild_members WHERE guild = v_guild AND pseudo = ANY (p_removals);
            GET DIAGNOSTICS v_removed = ROW_COUNT;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'row_refused: removal (%)', SQLERRM USING ERRCODE = '22023';
        END;
    END IF;

    RETURN jsonb_build_object('ok', true, 'updated', v_updated, 'added', v_added, 'removed', v_removed, 'ranks_assigned', v_ranks);
END;
$function$;

-- ── Migration groups ─────────────────────────────────────────────────────────

-- Creates a cross-server migration group with its servers (super_admin only,
-- like the table policies). It used to be able to leave an "open" group with
-- no servers when the second insert failed.
CREATE OR REPLACE FUNCTION public.gm_create_migration_group(p_name text, p_servers text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_name    text := btrim(COALESCE(p_name, ''));
    v_servers text[];
    v_id      uuid;
BEGIN
    IF auth.uid() IS NULL OR NOT public.gm_session_is_valid() OR NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    v_servers := ARRAY(SELECT DISTINCT btrim(s) FROM unnest(COALESCE(p_servers, '{}')) s WHERE btrim(s) <> '' ORDER BY 1);
    IF v_name = '' OR length(v_name) > 100 OR cardinality(v_servers) NOT BETWEEN 2 AND 50
       OR EXISTS (SELECT 1 FROM unnest(v_servers) s WHERE length(s) > 16) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;

    INSERT INTO public.server_migration_groups (name, status) VALUES (v_name, 'open') RETURNING id INTO v_id;
    INSERT INTO public.server_migration_group_servers (group_id, server_number)
    SELECT v_id, s FROM unnest(v_servers) s;

    RETURN jsonb_build_object('ok', true, 'id', v_id, 'servers', cardinality(v_servers));
END;
$function$;

-- ── Grants ───────────────────────────────────────────────────────────────────

DO $grants$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.gm_reschedule_event_session(text, text, text, text, timestamp with time zone)',
        'public.gm_delete_event_session(text, text, text)',
        'public.gm_clear_event_history(text, text[])',
        'public.gm_delete_history_session(text, text, date, text)',
        'public.gm_ban_member(text, text, text, text)',
        'public.gm_add_member(text, jsonb)',
        'public.gm_update_member(text, text, jsonb)',
        'public.gm_record_event_attendance(text, text, text, date, jsonb)',
        'public.gm_commit_ocr_roster(text, text, jsonb, jsonb, text[])',
        'public.gm_create_migration_group(text, text[])'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
    END LOOP;
END;
$grants$;

-- End state: the daily scores follow a renamed war session.
DO $check$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_event_daily_scores_session'
           AND conrelid = 'public.event_daily_scores'::regclass
           AND confupdtype = 'c' AND confdeltype = 'c' AND condeferrable) THEN
        RAISE EXCEPTION 'fk_event_daily_scores_session does not cascade on update';
    END IF;
END;
$check$;

NOTIFY pgrst, 'reload schema';
