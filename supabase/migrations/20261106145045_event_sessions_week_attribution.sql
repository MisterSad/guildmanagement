-- An event counts in the week of its START date (ADR-023).
--
-- Before this, the week of a participation row (`event_participants.week_start`)
-- was decided by whoever wrote the row, mostly the browser, and fell back to
-- "now" whenever the start date was missing:
--   * ending an Arms Race stage or a Shadowfront squad wrote
--     `event_status.start_at = NULL`, so the start of a finished session was
--     stored nowhere;
--   * every later write for that session (OCR import, history edit, a member
--     added) then sent `getWeekStart(start_at || new Date())`: the week the
--     officer happened to be typing in, not the week the event started;
--   * gm_add_member_to_active_events fell back to `updated_at`,
--     gm_upsert_daily_scores and gm_sync_shadowfront_participants to `now()`,
--     a transfer to `start_at::date` (not a Monday);
--   * gm_upsert_war_session replaced `war_sessions.start_at` with `now()` on
--     every save (audit EVT-02).
-- Measured on 2026-11-06: 12 sessions split across two weeks (1,500 rows),
-- 33 rows whose week disagrees with the date in their own session id, 34 rows
-- on a week_start that is not a Monday, 234 Shadowfront squad rows filed one
-- to six weeks before their session, 19 of 91 war sessions dated outside
-- their own ISO week.
--
-- Owner decisions (2026-11-06):
--   1. Every session has a start date AND time; it is mandatory.
--   2. A session counts in the ISO week (Monday 00:00 UTC) of that start,
--      whenever it is closed or its scores are typed.
--   3. The reference time zone is UTC.
--   4. Correcting a start date moves every row of the session to the new week.
--
-- Design: one registry row per session (`event_sessions`) holds the start.
-- Triggers derive `week_start` from it for EVERY write path (RPCs, direct
-- PostgREST writes by `authenticated`, service-role Edge Functions, the
-- Discord worker), so no caller can file a row in the wrong week, and none of
-- them needs to send a week at all. A session id is unique per guild across
-- events (ARA-/ARB-/DTR-/SF1-/SF2- + date, SVS-/GVG-/GLORY- + ISO week), so
-- the registry is keyed (guild, session_id).

-- ── 1. Helpers ──────────────────────────────────────────────────────────────

-- The ISO week (Monday, UTC) of an instant.
CREATE OR REPLACE FUNCTION public.gm_week_of(p_at timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT (date_trunc('week', p_at AT TIME ZONE 'UTC'))::date
$$;

-- The start an id implies when nothing better is known: the day of a daily
-- session (00:00 UTC), the Monday of a weekly one. NULL for any other shape.
CREATE OR REPLACE FUNCTION public.gm_session_start_from_id(p_session_id text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_part text;
BEGIN
    IF p_session_id IS NULL THEN
        RETURN NULL;
    END IF;
    v_part := substring(p_session_id FROM '-([0-9]{8})(?:-[0-9]+)?$');
    IF v_part IS NOT NULL THEN
        RETURN (to_date(v_part, 'YYYYMMDD')::timestamp) AT TIME ZONE 'UTC';
    END IF;
    v_part := substring(p_session_id FROM '-([0-9]{4}-W[0-9]{2})$');
    IF v_part IS NOT NULL THEN
        RETURN (to_date(replace(v_part, '-W', '-'), 'IYYY-IW')::timestamp) AT TIME ZONE 'UTC';
    END IF;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    -- An impossible date in an id (ARA-20261399-1) implies nothing.
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_week_of(timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gm_session_start_from_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_week_of(timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gm_session_start_from_id(text) TO authenticated, service_role;

-- ── 2. The registry ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_sessions (
    guild        text        NOT NULL,
    session_id   text        NOT NULL CHECK (length(session_id) BETWEEN 1 AND 64),
    event_name   text        NOT NULL CHECK (length(event_name) BETWEEN 1 AND 64),
    start_at     timestamptz NOT NULL,
    week_start   date        NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    -- 'officer': picked in the start dialog; 'derived': implied by the id
    -- because a row arrived before any start was known; 'backfill': rebuilt
    -- by this migration. An officer's start always replaces the other two.
    start_source text        NOT NULL DEFAULT 'officer'
                             CHECK (start_source IN ('officer', 'derived', 'backfill')),
    ended_at     timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild, session_id),
    -- The guild TAG is a mutable tenant key (ADR-022): the registry follows a
    -- rename and goes with a deleted guild.
    CONSTRAINT event_sessions_guild_fkey FOREIGN KEY (guild) REFERENCES public.guilds (id)
        ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS event_sessions_guild_week_idx ON public.event_sessions (guild, week_start);

COMMENT ON TABLE public.event_sessions IS
    'One row per event session: its start (UTC) and the ISO week it counts in (ADR-023). Written only by triggers and SECURITY DEFINER functions.';

-- Written only by the SECURITY DEFINER functions below: RLS forced with no
-- policy, no grant to the API roles.
ALTER TABLE public.event_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_sessions TO service_role;

-- week_start is always the week of start_at.
CREATE OR REPLACE FUNCTION public.gm_event_sessions_set_week()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.week_start := public.gm_week_of(NEW.start_at);
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_sessions_set_week ON public.event_sessions;
CREATE TRIGGER trg_event_sessions_set_week
    BEFORE INSERT OR UPDATE OF start_at ON public.event_sessions
    FOR EACH ROW EXECUTE FUNCTION public.gm_event_sessions_set_week();

-- The week of a session, registering the session (start implied by its id)
-- when a row arrives before anyone recorded a start. A row with no session id
-- (legacy Glory) keeps its own week, normalised to the Monday.
CREATE OR REPLACE FUNCTION public.gm_session_week(
    p_guild text, p_session_id text, p_event_name text, p_hint date)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_week  date;
    v_start timestamptz;
BEGIN
    IF p_session_id IS NULL THEN
        RETURN public.gm_week_of(COALESCE(p_hint::timestamp AT TIME ZONE 'UTC', now()));
    END IF;

    SELECT es.week_start INTO v_week
      FROM public.event_sessions es
     WHERE es.guild = p_guild AND es.session_id = p_session_id;
    IF FOUND THEN
        RETURN v_week;
    END IF;

    v_start := COALESCE(public.gm_session_start_from_id(p_session_id),
                        p_hint::timestamp AT TIME ZONE 'UTC',
                        now());
    INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source)
    VALUES (p_guild, p_session_id, COALESCE(NULLIF(btrim(p_event_name), ''), 'unknown'), v_start, 'derived')
    ON CONFLICT (guild, session_id) DO NOTHING;

    SELECT es.week_start INTO v_week
      FROM public.event_sessions es
     WHERE es.guild = p_guild AND es.session_id = p_session_id;
    RETURN v_week;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_session_week(text, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_session_week(text, text, text, date) TO service_role;

-- ── 3. Backfill the registry from what exists ───────────────────────────────

-- 3a. The current session of each event, with the start an officer picked.
INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source, ended_at)
SELECT es.guild, es.session_id, es.event_name, es.start_at, 'officer',
       CASE WHEN es.is_active THEN NULL ELSE es.updated_at END
  FROM public.event_status es
 WHERE es.session_id IS NOT NULL AND es.start_at IS NOT NULL
ON CONFLICT (guild, session_id) DO NOTHING;

-- 3b. War sessions: their start_at when it falls inside the week their own id
-- names (it was overwritten with now() on save, EVT-02), else that Monday.
INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source, ended_at)
SELECT ws.guild, ws.session_id, ws.event_name,
       CASE
         WHEN ws.start_at IS NOT NULL
          AND public.gm_week_of(ws.start_at) = public.gm_week_of(public.gm_session_start_from_id(ws.session_id))
         THEN ws.start_at
         ELSE COALESCE(public.gm_session_start_from_id(ws.session_id), ws.start_at, ws.created_at)
       END,
       'backfill', ws.updated_at
  FROM public.war_sessions ws
ON CONFLICT (guild, session_id) DO NOTHING;

-- 3c. Every other session that has rows: the start its id implies, else the
-- first row's creation.
INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source, ended_at)
SELECT ep.guild, ep.session_id, min(ep.event_name),
       COALESCE(public.gm_session_start_from_id(ep.session_id),
                min(ep.created_at),
                (min(ep.week_start)::timestamp) AT TIME ZONE 'UTC'),
       'backfill', max(ep.created_at)
  FROM public.event_participants ep
 WHERE ep.session_id IS NOT NULL
 GROUP BY ep.guild, ep.session_id
ON CONFLICT (guild, session_id) DO NOTHING;

INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source, ended_at)
SELECT sq.guild, sq.session_id, 'Shadowfront',
       COALESCE(public.gm_session_start_from_id(sq.session_id), (min(sq.week_start)::timestamp) AT TIME ZONE 'UTC'),
       'backfill', now()
  FROM public.shadowfront_squads sq
 WHERE sq.session_id IS NOT NULL
 GROUP BY sq.guild, sq.session_id
ON CONFLICT (guild, session_id) DO NOTHING;

-- 3d. Give back to the status rows the start their end wiped.
UPDATE public.event_status es
   SET start_at = r.start_at
  FROM public.event_sessions r
 WHERE es.start_at IS NULL AND r.guild = es.guild AND r.session_id = es.session_id;

-- ── 4. Record what is about to move, for the snapshots and the audit log ────

CREATE TEMP TABLE _week_moves ON COMMIT DROP AS
SELECT 'event_participants'::text AS tbl, ep.guild, ep.week_start AS old_week, r.week_start AS new_week
  FROM public.event_participants ep
  JOIN public.event_sessions r ON r.guild = ep.guild AND r.session_id = ep.session_id
 WHERE ep.week_start IS DISTINCT FROM r.week_start
UNION ALL
SELECT 'event_participants', ep.guild, ep.week_start, public.gm_week_of(ep.week_start::timestamp AT TIME ZONE 'UTC')
  FROM public.event_participants ep
 WHERE ep.session_id IS NULL AND extract(isodow FROM ep.week_start) <> 1
UNION ALL
SELECT 'shadowfront_squads', sq.guild, sq.week_start, r.week_start
  FROM public.shadowfront_squads sq
  JOIN public.event_sessions r ON r.guild = sq.guild AND r.session_id = sq.session_id
 WHERE sq.week_start IS DISTINCT FROM r.week_start
UNION ALL
SELECT 'shadowfront_squads', sq.guild, sq.week_start, public.gm_week_of(sq.week_start::timestamp AT TIME ZONE 'UTC')
  FROM public.shadowfront_squads sq
 WHERE sq.session_id IS NULL AND extract(isodow FROM sq.week_start) <> 1;

-- ── 5. Realign the rows on their session's week ─────────────────────────────

UPDATE public.event_participants ep
   SET week_start = r.week_start
  FROM public.event_sessions r
 WHERE r.guild = ep.guild AND r.session_id = ep.session_id
   AND ep.week_start IS DISTINCT FROM r.week_start;

UPDATE public.event_participants
   SET week_start = public.gm_week_of(week_start::timestamp AT TIME ZONE 'UTC')
 WHERE session_id IS NULL AND extract(isodow FROM week_start) <> 1;

UPDATE public.shadowfront_squads sq
   SET week_start = r.week_start
  FROM public.event_sessions r
 WHERE r.guild = sq.guild AND r.session_id = sq.session_id
   AND sq.week_start IS DISTINCT FROM r.week_start;

UPDATE public.shadowfront_squads
   SET week_start = public.gm_week_of(week_start::timestamp AT TIME ZONE 'UTC')
 WHERE session_id IS NULL AND extract(isodow FROM week_start) <> 1;

CREATE TEMP TABLE _war_moves ON COMMIT DROP AS
SELECT ws.guild, ws.session_id, ws.start_at AS old_start, r.start_at AS new_start
  FROM public.war_sessions ws
  JOIN public.event_sessions r ON r.guild = ws.guild AND r.session_id = ws.session_id
 WHERE ws.start_at IS DISTINCT FROM r.start_at;

UPDATE public.war_sessions ws
   SET start_at = r.start_at
  FROM public.event_sessions r
 WHERE r.guild = ws.guild AND r.session_id = ws.session_id
   AND ws.start_at IS DISTINCT FROM r.start_at;

-- ── 6. Constraints: a week starts on a Monday; a running session has a start ─

ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_week_start_monday;
ALTER TABLE public.event_participants
    ADD CONSTRAINT event_participants_week_start_monday CHECK (extract(isodow FROM week_start) = 1);
ALTER TABLE public.shadowfront_squads DROP CONSTRAINT IF EXISTS shadowfront_squads_week_start_monday;
ALTER TABLE public.shadowfront_squads
    ADD CONSTRAINT shadowfront_squads_week_start_monday CHECK (extract(isodow FROM week_start) = 1);
ALTER TABLE public.event_status DROP CONSTRAINT IF EXISTS event_status_active_has_start;
ALTER TABLE public.event_status
    ADD CONSTRAINT event_status_active_has_start CHECK (NOT is_active OR session_id IS NULL OR start_at IS NOT NULL);

-- ── 7. Triggers: every write path takes its week from the registry ──────────

-- Participation rows and squad rows: week_start is the session's week,
-- whatever the caller sent. Fires on the columns that decide it, not on a
-- guild rename's cascade (the registry follows that by its own FK).
CREATE OR REPLACE FUNCTION public.gm_rows_take_session_week()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- shadowfront_squads has no event_name column: name the field only on the
    -- table that has it, or PL/pgSQL fails to resolve NEW.event_name.
    IF TG_TABLE_NAME = 'shadowfront_squads' THEN
        NEW.week_start := public.gm_session_week(NEW.guild, NEW.session_id, 'Shadowfront', NEW.week_start);
    ELSE
        NEW.week_start := public.gm_session_week(NEW.guild, NEW.session_id, NEW.event_name, NEW.week_start);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_participants_session_week ON public.event_participants;
CREATE TRIGGER trg_event_participants_session_week
    BEFORE INSERT OR UPDATE OF week_start, session_id ON public.event_participants
    FOR EACH ROW EXECUTE FUNCTION public.gm_rows_take_session_week();

DROP TRIGGER IF EXISTS trg_shadowfront_squads_session_week ON public.shadowfront_squads;
CREATE TRIGGER trg_shadowfront_squads_session_week
    BEFORE INSERT OR UPDATE OF week_start, session_id ON public.shadowfront_squads
    FOR EACH ROW EXECUTE FUNCTION public.gm_rows_take_session_week();

-- A war session's start is its session's start (fixes EVT-02 at the source:
-- gm_upsert_war_session can no longer stamp now() over it).
CREATE OR REPLACE FUNCTION public.gm_war_sessions_take_session_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_start timestamptz;
BEGIN
    PERFORM public.gm_session_week(NEW.guild, NEW.session_id, NEW.event_name,
                                   public.gm_week_of(COALESCE(NEW.start_at, now())));
    SELECT es.start_at INTO v_start
      FROM public.event_sessions es
     WHERE es.guild = NEW.guild AND es.session_id = NEW.session_id;
    NEW.start_at := v_start;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_war_sessions_session_start ON public.war_sessions;
CREATE TRIGGER trg_war_sessions_session_start
    BEFORE INSERT OR UPDATE OF start_at, session_id ON public.war_sessions
    FOR EACH ROW EXECUTE FUNCTION public.gm_war_sessions_take_session_start();

-- The status row records the start an officer picked into the registry, and
-- can no longer lose it: an end that writes start_at = NULL keeps the start.
CREATE OR REPLACE FUNCTION public.gm_event_status_keep_start()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.start_at IS NULL AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id THEN
        NEW.start_at := OLD.start_at;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_status_keep_start ON public.event_status;
CREATE TRIGGER trg_event_status_keep_start
    BEFORE UPDATE ON public.event_status
    FOR EACH ROW EXECUTE FUNCTION public.gm_event_status_keep_start();

CREATE OR REPLACE FUNCTION public.gm_event_status_register_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.session_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF NEW.start_at IS NOT NULL THEN
        INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source, ended_at)
        VALUES (NEW.guild, NEW.session_id, NEW.event_name, NEW.start_at, 'officer',
                CASE WHEN NEW.is_active THEN NULL ELSE now() END)
        ON CONFLICT (guild, session_id) DO UPDATE
           SET start_at     = EXCLUDED.start_at,
               event_name   = EXCLUDED.event_name,
               start_source = 'officer',
               ended_at     = CASE WHEN NEW.is_active THEN NULL
                                   ELSE COALESCE(public.event_sessions.ended_at, now()) END;
    ELSE
        PERFORM public.gm_session_week(NEW.guild, NEW.session_id, NEW.event_name, NULL);
        IF NOT NEW.is_active THEN
            UPDATE public.event_sessions
               SET ended_at = COALESCE(ended_at, now())
             WHERE guild = NEW.guild AND session_id = NEW.session_id;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_status_register_session ON public.event_status;
CREATE TRIGGER trg_event_status_register_session
    AFTER INSERT OR UPDATE OF session_id, start_at, is_active ON public.event_status
    FOR EACH ROW EXECUTE FUNCTION public.gm_event_status_register_session();

-- Correcting a start moves the whole session (owner decision 4).
CREATE OR REPLACE FUNCTION public.gm_event_sessions_propagate_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.start_at IS NOT DISTINCT FROM OLD.start_at THEN
        RETURN NULL;
    END IF;
    IF NEW.week_start IS DISTINCT FROM OLD.week_start THEN
        UPDATE public.event_participants
           SET week_start = NEW.week_start
         WHERE guild = NEW.guild AND session_id = NEW.session_id
           AND week_start IS DISTINCT FROM NEW.week_start;
        UPDATE public.shadowfront_squads
           SET week_start = NEW.week_start
         WHERE guild = NEW.guild AND session_id = NEW.session_id
           AND week_start IS DISTINCT FROM NEW.week_start;
    END IF;
    UPDATE public.war_sessions
       SET start_at = NEW.start_at, updated_at = now()
     WHERE guild = NEW.guild AND session_id = NEW.session_id
       AND start_at IS DISTINCT FROM NEW.start_at;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_sessions_propagate_start ON public.event_sessions;
CREATE TRIGGER trg_event_sessions_propagate_start
    AFTER UPDATE OF start_at ON public.event_sessions
    FOR EACH ROW EXECUTE FUNCTION public.gm_event_sessions_propagate_start();

-- Trigger functions are not callable through the API.
REVOKE ALL ON FUNCTION public.gm_event_sessions_set_week() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_rows_take_session_week() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_war_sessions_take_session_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_event_status_keep_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_event_status_register_session() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_event_sessions_propagate_start() FROM PUBLIC, anon, authenticated;

-- ── 8. Session lifecycle RPCs ───────────────────────────────────────────────

-- Starts a session server-side: the start is mandatory, the id (and its
-- same-day suffix, EVT-05) is computed here from that start.
CREATE OR REPLACE FUNCTION public.gm_start_event_session(
    p_guild text, p_event_name text, p_stage text, p_start_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guild  text := public.gm_require_guild_write(p_guild);
    v_event  text := btrim(COALESCE(p_event_name, ''));
    v_stage  text := NULLIF(btrim(COALESCE(p_stage, '')), '');
    v_prefix text;
    v_base   text;
    v_sid    text;
    v_n      integer := 1;
    v_active text;
BEGIN
    IF v_event = '' OR length(v_event) > 64 OR length(COALESCE(v_stage, '')) > 32 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    IF p_start_at IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'start_required');
    END IF;
    IF p_start_at < now() - interval '60 days' OR p_start_at > now() + interval '14 days' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'start_out_of_range');
    END IF;

    SELECT es.session_id INTO v_active
      FROM public.event_status es
     WHERE es.guild = v_guild AND es.event_name = v_event AND es.is_active;
    IF v_active IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_active', 'session_id', v_active);
    END IF;

    v_prefix := CASE upper(v_event)
        WHEN 'SVS' THEN 'SVS'
        WHEN 'GVG' THEN 'GVG'
        WHEN 'ARMS RACE STAGE A' THEN 'ARA'
        WHEN 'ARMS RACE STAGE B' THEN 'ARB'
        WHEN 'DEFEND TRADE ROUTE' THEN 'DTR'
        WHEN 'SHADOWFRONT SQUAD 1' THEN 'SF1'
        WHEN 'SHADOWFRONT SQUAD 2' THEN 'SF2'
        ELSE NULL END;
    IF v_prefix IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unknown_event');
    END IF;

    IF v_prefix IN ('SVS', 'GVG') THEN
        v_sid := v_prefix || '-' || to_char(p_start_at AT TIME ZONE 'UTC', 'IYYY-"W"IW');
    ELSE
        v_base := v_prefix || '-' || to_char(p_start_at AT TIME ZONE 'UTC', 'YYYYMMDD');
        LOOP
            v_sid := v_base || '-' || v_n;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.event_sessions WHERE guild = v_guild AND session_id = v_sid)
                  AND NOT EXISTS (SELECT 1 FROM public.event_participants WHERE guild = v_guild AND session_id = v_sid)
                  AND NOT EXISTS (SELECT 1 FROM public.event_status WHERE guild = v_guild AND session_id = v_sid);
            v_n := v_n + 1;
            IF v_n > 50 THEN
                RETURN jsonb_build_object('ok', false, 'error', 'too_many_sessions');
            END IF;
        END LOOP;
    END IF;

    INSERT INTO public.event_status (guild, event_name, session_id, is_active, stage, start_at, updated_at)
    VALUES (v_guild, v_event, v_sid, true, v_stage, p_start_at, now())
    ON CONFLICT (guild, event_name) DO UPDATE
       SET session_id = EXCLUDED.session_id, is_active = true, stage = EXCLUDED.stage,
           start_at = EXCLUDED.start_at, updated_at = now();

    RETURN jsonb_build_object('ok', true, 'session_id', v_sid,
                              'week_start', public.gm_week_of(p_start_at), 'start_at', p_start_at);
END;
$$;

-- Ends a session and keeps its start. Refuses a stale tab (EVT-07): the
-- session to end must still be the current one.
CREATE OR REPLACE FUNCTION public.gm_end_event_session(p_guild text, p_event_name text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guild text := public.gm_require_guild_write(p_guild);
    v_event text := btrim(COALESCE(p_event_name, ''));
    v_sid   text := NULLIF(btrim(COALESCE(p_session_id, '')), '');
    v_cur   text;
BEGIN
    IF v_event = '' OR length(v_event) > 64 OR v_sid IS NULL OR length(v_sid) > 64 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_request');
    END IF;
    SELECT es.session_id INTO v_cur
      FROM public.event_status es
     WHERE es.guild = v_guild AND es.event_name = v_event
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'no_session');
    END IF;
    IF v_cur IS DISTINCT FROM v_sid THEN
        RETURN jsonb_build_object('ok', false, 'error', 'stale_session', 'session_id', v_cur);
    END IF;

    UPDATE public.event_status
       SET is_active = false, updated_at = now()
     WHERE guild = v_guild AND event_name = v_event;

    RETURN jsonb_build_object('ok', true, 'session_id', v_sid);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_start_event_session(text, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gm_end_event_session(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_start_event_session(text, text, text, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gm_end_event_session(text, text, text) TO authenticated, service_role;

-- Reschedule: the registry moves first, so every row that follows finds the
-- new week. A new id that is already a real session is refused instead of
-- merging two sessions (EVT-05).
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
    v_week := public.gm_week_of(p_start_at);

    IF NOT EXISTS (SELECT 1 FROM public.event_status WHERE guild = v_guild AND event_name = v_event) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'no_session');
    END IF;

    IF v_new IS DISTINCT FROM v_old THEN
        IF EXISTS (SELECT 1 FROM public.event_participants WHERE guild = v_guild AND session_id = v_new)
           OR EXISTS (SELECT 1 FROM public.war_sessions WHERE guild = v_guild AND session_id = v_new) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'session_exists');
        END IF;
        -- An empty leftover registry row under the new id is not a session.
        DELETE FROM public.event_sessions WHERE guild = v_guild AND session_id = v_new;
        UPDATE public.event_sessions
           SET session_id = v_new, start_at = p_start_at, start_source = 'officer', event_name = v_event
         WHERE guild = v_guild AND session_id = v_old;
    ELSE
        UPDATE public.event_sessions
           SET start_at = p_start_at, start_source = 'officer', event_name = v_event
         WHERE guild = v_guild AND session_id = v_old;
    END IF;
    IF NOT FOUND THEN
        INSERT INTO public.event_sessions (guild, session_id, event_name, start_at, start_source)
        VALUES (v_guild, v_new, v_event, p_start_at, 'officer')
        ON CONFLICT (guild, session_id) DO UPDATE SET start_at = EXCLUDED.start_at, start_source = 'officer';
    END IF;

    -- Rows still under the old id take the new week directly (the registry
    -- row has already moved to the new id).
    IF v_sf THEN
        UPDATE public.shadowfront_squads SET session_id = v_new
         WHERE guild = v_guild AND session_id = v_old;
    END IF;
    UPDATE public.event_participants SET session_id = v_new
     WHERE guild = v_guild AND event_name = v_part AND session_id = v_old;
    IF v_war THEN
        -- event_daily_scores follows through fk_event_daily_scores_session.
        UPDATE public.war_sessions SET session_id = v_new, updated_at = now()
         WHERE guild = v_guild AND event_name = v_event AND session_id = v_old;
    END IF;
    UPDATE public.event_status SET session_id = v_new, start_at = p_start_at, updated_at = now()
     WHERE guild = v_guild AND event_name = v_event;

    RETURN jsonb_build_object('ok', true, 'session_id', v_new, 'week_start', v_week);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_reschedule_event_session(text, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_reschedule_event_session(text, text, text, text, timestamptz) TO authenticated;

-- ── 9. History lists the start the registry holds ───────────────────────────

CREATE OR REPLACE FUNCTION public.gm_list_event_sessions(p_guild text DEFAULT NULL::text)
RETURNS TABLE(event_name text, display_name text, session_id text, week_start date, start_at timestamp with time zone, participants integer, participated_count integer, total_score bigint, granular boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_guild text;
    v_target_server text;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active';

    -- Only admins (or super admins) may list sessions; members use the portal.
    IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
        RETURN;
    END IF;

    -- No fallback: an unresolved guild lists nothing.
    IF v_caller_role = 'guild_admin' THEN
        v_target_guild := v_caller_guild;
    ELSE
        v_target_guild := COALESCE(p_guild, v_caller_guild);
    END IF;
    IF v_target_guild IS NULL OR v_target_guild = '' THEN
        RETURN;
    END IF;

    IF v_caller_role = 'server_admin' THEN
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target_guild;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
            RETURN;
        END IF;
    END IF;

    RETURN QUERY
    SELECT base.event_name,
           base.display_name,
           base.session_id,
           base.week_start,
           base.start_at,
           base.participants,
           base.participated_count,
           base.total_score,
           EXISTS (
               SELECT 1 FROM public.war_sessions ws
               WHERE ws.guild = v_target_guild
                 AND ws.event_name = base.event_name
                 AND ws.session_id = base.session_id
           ) AS granular
    FROM (
        SELECT
            ep.event_name,
            COALESCE(es.event_name, ep.event_name) AS display_name,
            COALESCE(ep.session_id, ep.week_start::text) AS session_id,
            MIN(ep.week_start) AS week_start,
            MAX(COALESCE(rs.start_at, es.start_at)) AS start_at,
            COUNT(*)::integer AS participants,
            SUM(CASE WHEN ep.participated > 0 OR COALESCE(ep.score, 0) > 0 OR COALESCE(ep.score_prep, 0) > 0 OR COALESCE(ep.score_pvp, 0) > 0 THEN 1 ELSE 0 END)::integer AS participated_count,
            SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0))::bigint AS total_score
        FROM public.event_participants ep
        LEFT JOIN public.event_sessions rs
          ON rs.guild = ep.guild AND rs.session_id = ep.session_id
        LEFT JOIN public.event_status es
          ON es.guild = ep.guild
         AND es.session_id = ep.session_id
         AND (
           LOWER(es.event_name) = LOWER(ep.event_name)
           OR (ep.event_name = 'Shadowfront' AND es.event_name LIKE 'Shadowfront%')
         )
        WHERE ep.guild = v_target_guild
        GROUP BY ep.event_name, COALESCE(es.event_name, ep.event_name), COALESCE(ep.session_id, ep.week_start::text)
    ) base
    ORDER BY COALESCE(base.start_at, (base.week_start || 'T12:00:00')::timestamptz) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_list_event_sessions(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_event_sessions(text) TO authenticated;

-- ── 10. Snapshots of every week that gained or lost rows, and an audit line ─

DO $snap$
DECLARE
    r record;
    v_rows integer;
    v_squads integer;
    v_wars integer;
    v_weeks integer := 0;
BEGIN
    SELECT count(*) FILTER (WHERE tbl = 'event_participants'),
           count(*) FILTER (WHERE tbl = 'shadowfront_squads')
      INTO v_rows, v_squads FROM _week_moves;
    SELECT count(*) INTO v_wars FROM _war_moves;

    -- Only weeks that already had a snapshot, or that are complete: the cron
    -- writes the current week itself on Monday.
    FOR r IN
        SELECT DISTINCT m.guild, w.week
          FROM _week_moves m
          CROSS JOIN LATERAL (VALUES (m.old_week), (m.new_week)) w(week)
         WHERE m.tbl = 'event_participants' AND w.week IS NOT NULL
           AND w.week < public.gm_week_of(now())
           AND EXISTS (SELECT 1 FROM public.guilds g WHERE g.id = m.guild)
    LOOP
        IF public.gm_stats_snapshot_upsert(r.guild, public.gm_week_of(r.week::timestamp AT TIME ZONE 'UTC'), 'backfill') THEN
            v_weeks := v_weeks + 1;
        END IF;
    END LOOP;

    INSERT INTO public.system_audit_logs (level, service, action_type, message, metadata, created_at)
    VALUES ('INFO', 'migration', 'event_week_attribution',
            'Event rows realigned on the week of their session start (ADR-023)',
            jsonb_build_object('participant_rows', v_rows, 'squad_rows', v_squads,
                               'war_sessions', v_wars, 'snapshots_recomputed', v_weeks,
                               'sessions_registered', (SELECT count(*) FROM public.event_sessions)),
            now());
END
$snap$;

-- ── 11. Assert the end state ────────────────────────────────────────────────

DO $check$
BEGIN
    IF EXISTS (SELECT 1 FROM public.event_participants ep
                 JOIN public.event_sessions r ON r.guild = ep.guild AND r.session_id = ep.session_id
                WHERE ep.week_start <> r.week_start) THEN
        RAISE EXCEPTION 'a participation row is not on its session''s week';
    END IF;
    IF EXISTS (SELECT 1 FROM public.event_participants ep
                WHERE ep.session_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM public.event_sessions r
                                   WHERE r.guild = ep.guild AND r.session_id = ep.session_id)) THEN
        RAISE EXCEPTION 'a session with rows is missing from the registry';
    END IF;
    IF EXISTS (SELECT 1 FROM public.war_sessions ws
                 JOIN public.event_sessions r ON r.guild = ws.guild AND r.session_id = ws.session_id
                WHERE ws.start_at IS DISTINCT FROM r.start_at) THEN
        RAISE EXCEPTION 'a war session does not carry its session''s start';
    END IF;
    IF has_table_privilege('authenticated', 'public.event_sessions', 'SELECT')
       OR has_table_privilege('anon', 'public.event_sessions', 'SELECT') THEN
        RAISE EXCEPTION 'event_sessions must not be readable by the API roles';
    END IF;
    IF has_function_privilege('authenticated', 'public.gm_session_week(text, text, text, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.gm_start_event_session(text, text, text, timestamptz)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.gm_start_event_session(text, text, text, timestamptz)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.gm_end_event_session(text, text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'unexpected grants on the session functions';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
