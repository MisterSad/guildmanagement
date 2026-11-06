-- Season 2: only a signed-in super admin, with the exact phrase, once; every
-- guild's recorded data goes, the players and their military stats stay.
BEGIN;
SELECT tests.fixture();

-- Some of everything, in two guilds.
UPDATE public.guild_members SET overall_power = 123456789, glory_score = 4242, tech_power = 777 WHERE guild = 'TA' AND pseudo = 'Alpha2';
INSERT INTO public.event_status (guild, event_name, session_id, is_active, start_at)
VALUES ('TA', 'SvS', 'SVS-2026-W44', true, '2026-10-26T10:00:00Z'),
       ('TB', 'Defend Trade Route', 'DTR-20261101-1', false, '2026-11-01T20:00:00Z');
INSERT INTO public.war_sessions (guild, event_name, session_id, start_at) VALUES ('TA', 'SvS', 'SVS-2026-W44', '2026-10-26T10:00:00Z');
INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score) VALUES
  ('TA', 'SvS', 'SVS-2026-W44', '2026-10-26', 'Alpha2', 1, 1000),
  ('TA', 'Glory', 'GLORY-2026-W44', '2026-10-26', 'Alpha2', 1, 4242),
  ('TB', 'Defend Trade Route', 'DTR-20261101-1', '2026-10-26', 'Beta2', 1, 5);
INSERT INTO public.event_daily_scores (guild, event_name, session_id, pseudo, day, score) VALUES ('TA', 'SvS', 'SVS-2026-W44', 'Alpha2', 1, 500);
INSERT INTO public.player_metrics_history (guild, pseudo, week_start, total_power) VALUES ('TA', 'Alpha2', '2026-10-26', 123456789);
INSERT INTO public.war_opponents (guild, kind, name) VALUES ('TA', 'guild', 'Rivals');

-- ── Who may start it ─────────────────────────────────────────────────────────
SELECT tests.assert_eq(public.gm_season_status() ->> 'season', '1'::text, 'the app starts in season 1');
SELECT tests.login('t_member_a');
SELECT tests.assert_eq(public.gm_season_status() ->> 'season', '1'::text, 'any signed-in user can read the season');
SELECT tests.assert_raises($q$SELECT public.gm_start_season_2('START SEASON 2')$q$, 'a member cannot start Season 2', '42501');
SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_start_season_2('START SEASON 2')$q$, 'nor a guild admin', '42501');
SELECT tests.login('t_server');
SELECT tests.assert_raises($q$SELECT public.gm_start_season_2('START SEASON 2')$q$, 'nor a server admin', '42501');
SELECT tests.anon();
SELECT tests.assert_raises($q$SELECT public.gm_season_status()$q$, 'anon cannot even read the season', '42501');
SELECT tests.login('t_super');
SELECT tests.assert_eq(public.gm_start_season_2('start season 2') ->> 'error', 'confirmation_mismatch'::text,
                       'the confirmation phrase must be exact');
SELECT tests.assert_raises($q$SELECT count(*) FROM public.app_season$q$, 'the season table is not readable through the API', '42501');

-- ── Starting it ──────────────────────────────────────────────────────────────
SELECT tests.assert_eq(public.gm_start_season_2('START SEASON 2') ->> 'ok', 'true'::text, 'the super admin starts Season 2');
SELECT tests.assert_eq(public.gm_start_season_2('START SEASON 2') ->> 'error', 'already_started'::text, 'and it cannot run twice');
SELECT tests.assert_eq(public.gm_season_status() ->> 'season', '2'::text, 'the app is now in season 2');
SELECT tests.logout();

SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_participants), 0, 'every participation row is gone, weekly Glory included');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_daily_scores), 0, 'every daily score is gone');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.war_sessions), 0, 'every war session is gone');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.war_opponents), 0, 'every opponent list is gone');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_status), 0, 'every event status is gone');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.event_sessions), 0, 'every session registry row is gone');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.player_metrics_history), 0, 'the power history is gone');

SELECT tests.assert_eq((SELECT count(*)::int FROM public.guild_members), 7, 'every player stays');
SELECT tests.assert_eq((SELECT overall_power::text || '/' || glory_score::text || '/' || tech_power::text
                          FROM public.guild_members WHERE guild = 'TA' AND pseudo = 'Alpha2'),
                       '123456789/4242/777'::text, 'and their military stats stay as they were');
SELECT tests.assert_eq((SELECT count(*)::int FROM public.accounts), 6, 'every account stays');
SELECT tests.assert((SELECT count(*) = 1 FROM public.system_audit_logs WHERE action_type = 'season_2_started'),
                    'the start is in the audit log');

ROLLBACK;
