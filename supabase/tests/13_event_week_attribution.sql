-- ADR-023: an event counts in the ISO week (Monday, UTC) of its START,
-- whenever it is closed and whenever its scores are typed, whatever week the
-- caller sends. Dates are relative to now() so the file passes on any day.
BEGIN;
SELECT tests.fixture();

-- A Sunday 23:30 UTC a few weeks back: the last minute of its ISO week, the
-- case a "week of the closing day" rule gets wrong.
CREATE TEMP TABLE t_dates ON COMMIT DROP AS
SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - interval '14 days' - interval '30 minutes') AT TIME ZONE 'UTC' AS sunday_late,
       (date_trunc('week', now() AT TIME ZONE 'UTC') - interval '21 days')::date                        AS start_week,
       (date_trunc('week', now() AT TIME ZONE 'UTC'))::date                                             AS this_week;
GRANT SELECT ON t_dates TO authenticated;

-- ── Starting: mandatory start, server-built id ──────────────────────────────
SELECT tests.login('t_member_a');
SELECT tests.assert_raises($q$SELECT public.gm_start_event_session('TA', 'Defend Trade Route', NULL, now())$q$,
                           'a member cannot start a session', '42501');
SELECT tests.login('t_admin_b');
SELECT tests.assert_raises($q$SELECT public.gm_start_event_session('TA', 'Defend Trade Route', NULL, now())$q$,
                           'nor can another guild''s admin', '42501');

SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_start_event_session('TA', 'Defend Trade Route', NULL, NULL) ->> 'error',
                       'start_required'::text, 'a session cannot start without a start date');
SELECT tests.assert_eq(public.gm_start_event_session('TA', 'Defend Trade Route', NULL, now() - interval '90 days') ->> 'error',
                       'start_out_of_range'::text, 'an absurd start date is refused');

SELECT tests.assert_eq(public.gm_start_event_session('TA', 'Defend Trade Route', NULL, (SELECT sunday_late FROM t_dates)) ->> 'session_id',
                       'DTR-' || to_char((SELECT sunday_late FROM t_dates) AT TIME ZONE 'UTC', 'YYYYMMDD') || '-1',
                       'the server builds the id from the start date');
SELECT tests.assert_eq(public.gm_start_event_session('TA', 'Defend Trade Route', NULL, now()) ->> 'error',
                       'already_active'::text, 'a second start of a running event is refused');

-- ── Rows land in the start week whatever week the caller sends ──────────────
SELECT public.gm_populate_event_participants('Defend Trade Route',
    (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'Defend Trade Route'),
    (SELECT this_week FROM t_dates), 'TA');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(DISTINCT week_start)::int FROM public.event_participants
                         WHERE guild = 'TA' AND event_name = 'Defend Trade Route'), 1, 'populate files one week');
SELECT tests.assert_eq((SELECT min(week_start) FROM public.event_participants
                         WHERE guild = 'TA' AND event_name = 'Defend Trade Route'),
                       (SELECT start_week FROM t_dates), 'and it is the week of the Sunday start, not the current week');

-- Closing keeps the start; a stale tab cannot close it.
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_end_event_session('TA', 'Defend Trade Route', 'DTR-19990101-1') ->> 'error',
                       'stale_session'::text, 'a stale tab cannot end the current session');
SELECT tests.assert_eq(public.gm_end_event_session('TA', 'Defend Trade Route',
                         (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'Defend Trade Route')) ->> 'ok',
                       'true'::text, 'the current session ends');
SELECT tests.logout();
SELECT tests.assert((SELECT start_at = (SELECT sunday_late FROM t_dates) FROM public.event_status
                      WHERE guild = 'TA' AND event_name = 'Defend Trade Route'), 'ending keeps the start date');

-- After the close, in a later week: OCR attendance, a direct browser write,
-- an edit of the week: all stay in the start week.
SELECT tests.login('t_admin_a');
SELECT public.gm_record_event_attendance('TA', 'Defend Trade Route',
    (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'Defend Trade Route'),
    (SELECT this_week FROM t_dates), '[{"pseudo":"Alpha2"}]'::jsonb);
INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated)
SELECT 'TA', 'Defend Trade Route', es.session_id, (SELECT this_week FROM t_dates), 'Alpha3', 1
  FROM public.event_status es WHERE es.guild = 'TA' AND es.event_name = 'Defend Trade Route'
ON CONFLICT (guild, event_name, session_id, pseudo) DO UPDATE SET participated = 1, week_start = EXCLUDED.week_start;
UPDATE public.event_participants SET week_start = (SELECT this_week FROM t_dates)
 WHERE guild = 'TA' AND event_name = 'Defend Trade Route' AND pseudo = 'Alpha1';
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_participants
                         WHERE guild = 'TA' AND event_name = 'Defend Trade Route'
                           AND week_start <> (SELECT start_week FROM t_dates)), 0,
                       'OCR, a direct write and a week edit after the close all stay in the start week');
SELECT tests.assert_eq((SELECT participated FROM public.event_participants
                         WHERE guild = 'TA' AND event_name = 'Defend Trade Route' AND pseudo = 'Alpha2'), 1,
                       'and the attendance itself was recorded');

-- A second session the same day gets the next suffix (EVT-05).
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_start_event_session('TA', 'Defend Trade Route', NULL, (SELECT sunday_late FROM t_dates) - interval '1 hour') ->> 'session_id',
                       'DTR-' || to_char((SELECT sunday_late FROM t_dates) AT TIME ZONE 'UTC', 'YYYYMMDD') || '-2',
                       'a second session on the same day gets suffix -2');

-- ── A legacy end that writes start_at = NULL loses nothing ──────────────────
INSERT INTO public.event_status (guild, event_name, session_id, is_active, stage, start_at)
SELECT 'TA', 'ARMS RACE STAGE A', 'ARA-' || to_char((SELECT sunday_late FROM t_dates) AT TIME ZONE 'UTC', 'YYYYMMDD') || '-1', true, 'A',
       (SELECT sunday_late FROM t_dates)
ON CONFLICT (guild, event_name) DO NOTHING;
UPDATE public.event_status SET is_active = false, start_at = NULL WHERE guild = 'TA' AND event_name = 'ARMS RACE STAGE A';
SELECT tests.logout();
SELECT tests.assert((SELECT start_at IS NOT NULL FROM public.event_status WHERE guild = 'TA' AND event_name = 'ARMS RACE STAGE A'),
                    'an end that sends start_at = NULL keeps the start');
SELECT tests.assert_raises($q$INSERT INTO public.event_status (guild, event_name, session_id, is_active, start_at)
                              VALUES ('TB', 'GvG', 'GVG-2026-W01', true, NULL)$q$,
                           'a running session without a start is refused', '23514');

-- ── Reschedule: the whole session follows the corrected start ───────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_reschedule_event_session('TA', 'Defend Trade Route',
                         (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'Defend Trade Route'),
                         'DTR-' || to_char((SELECT sunday_late FROM t_dates) AT TIME ZONE 'UTC' - interval '6 days', 'YYYYMMDD') || '-1',
                         (SELECT sunday_late FROM t_dates) - interval '6 days') ->> 'ok',
                       'true'::text, 'the -2 session is moved six days earlier');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT week_start FROM public.event_sessions WHERE guild = 'TA' AND event_name = 'Defend Trade Route'
                          AND session_id LIKE 'DTR-' || to_char((SELECT sunday_late FROM t_dates) AT TIME ZONE 'UTC' - interval '6 days', 'YYYYMMDD') || '%'),
                       (SELECT start_week FROM t_dates), 'six days before a Sunday is the Monday of the same week');

-- Moving the first session one week back moves every one of its rows.
SELECT tests.login('t_admin_a');
SELECT public.gm_start_event_session('TA', 'GvG', NULL, (SELECT sunday_late FROM t_dates));
SELECT public.gm_populate_event_participants('GvG',
    (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'GvG'), (SELECT this_week FROM t_dates), 'TA');
SELECT public.gm_upsert_war_session('TA', 'GvG',
    (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'GvG'), NULL, NULL, NULL);
SELECT public.gm_upsert_war_session('TA', 'GvG',
    (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'GvG'), NULL, '{"day1":"win"}'::jsonb, now());
SELECT tests.logout();
SELECT tests.assert((SELECT ws.start_at = (SELECT sunday_late FROM t_dates) FROM public.war_sessions ws
                      WHERE ws.guild = 'TA' AND ws.event_name = 'GvG'),
                    'a war session keeps its session''s start, even when a save sends now() (EVT-02)');

SELECT tests.login('t_admin_a');
SELECT public.gm_reschedule_event_session('TA', 'GvG',
    (SELECT session_id FROM public.event_status WHERE guild = 'TA' AND event_name = 'GvG'),
    'GVG-' || to_char((SELECT sunday_late FROM t_dates) AT TIME ZONE 'UTC' - interval '7 days', 'IYYY-"W"IW'),
    (SELECT sunday_late FROM t_dates) - interval '7 days');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_participants
                         WHERE guild = 'TA' AND event_name = 'GvG'
                           AND week_start = (SELECT start_week FROM t_dates) - 7), 3,
                       'every GvG row moved to the corrected week');
SELECT tests.assert((SELECT ws.start_at = (SELECT sunday_late FROM t_dates) - interval '7 days' FROM public.war_sessions ws
                      WHERE ws.guild = 'TA' AND ws.event_name = 'GvG'),
                    'and the war session with them');

-- ── A member added during a session joins the session's week ────────────────
INSERT INTO public.guild_members (guild, pseudo, uid, role) VALUES ('TA', 'Alpha4', '7000004', 'R1');
SELECT tests.login('t_admin_a');
SELECT public.gm_add_member_to_active_events('Alpha4', 'TA');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT week_start FROM public.event_participants WHERE guild = 'TA' AND event_name = 'GvG' AND pseudo = 'Alpha4'),
                       (SELECT start_week FROM t_dates) - 7, 'a member added mid-session joins the session''s week');

-- ── A row with no session is normalised to its Monday ───────────────────────
INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated)
VALUES ('TA', 'Glory', NULL, (SELECT this_week FROM t_dates) + 3, 'Alpha1', 1);
SELECT tests.assert_eq((SELECT week_start FROM public.event_participants WHERE guild = 'TA' AND event_name = 'Glory' AND session_id IS NULL),
                       (SELECT this_week FROM t_dates), 'a row with no session lands on its Monday');

-- ── The registry is private and follows a TAG rename ────────────────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT count(*) FROM public.event_sessions$q$,
                           'the registry is not readable through the API', '42501');
SELECT tests.assert_raises($q$SELECT public.gm_session_week('TA', 'X-20260101-1', 'X', NULL)$q$,
                           'nor is its internal helper', '42501');
SELECT tests.assert_eq(public.gm_rename_guild('TA', 'TZ') ->> 'ok', 'true'::text, 'the guild is renamed');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_sessions WHERE guild = 'TA'), 0, 'no session stays under the old tag');
SELECT tests.assert((SELECT count(*) > 0 FROM public.event_sessions WHERE guild = 'TZ'), 'the sessions followed the rename');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_participants ep
                         JOIN public.event_sessions r ON r.guild = ep.guild AND r.session_id = ep.session_id
                        WHERE ep.guild = 'TZ' AND ep.week_start <> r.week_start), 0,
                       'and every row is still on its session''s week');

ROLLBACK;
