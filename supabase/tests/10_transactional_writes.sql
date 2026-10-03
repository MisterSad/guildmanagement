-- M4a: the browser's multi-step writes are single functions. Each is checked
-- for who may call it, for doing the whole job, and for doing NONE of it when
-- one step is refused (audit ARC-02, DB-11, DB-12).
BEGIN;
SELECT tests.fixture();

-- A running SvS with a war session and daily scores, a running Arms Race, a
-- Shadowfront squad session, and finished history.
INSERT INTO public.event_status (guild, event_name, session_id, is_active, start_at) VALUES
  ('TA', 'SvS', 'SVS-2026-W40', true, '2026-09-28T00:00:00Z'),
  ('TA', 'ARMS RACE STAGE A', 'ARA-20261001-1', true, '2026-10-01T12:00:00Z'),
  ('TA', 'Shadowfront Squad 1', 'SF1-20261002-1', true, '2026-10-02T18:00:00Z'),
  ('TA', 'Defend Trade Route', 'DTR-20260901-1', false, '2026-09-01T12:00:00Z');
INSERT INTO public.war_sessions (guild, event_name, session_id, start_at) VALUES ('TA', 'SvS', 'SVS-2026-W40', '2026-09-28T00:00:00Z');
INSERT INTO public.event_daily_scores (guild, event_name, session_id, pseudo, day, score) VALUES ('TA', 'SvS', 'SVS-2026-W40', 'Alpha2', 1, 500);
INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated) VALUES
  ('TA', 'SvS', 'SVS-2026-W40', '2026-09-28', 'Alpha2', 1),
  ('TA', 'ARMS RACE STAGE A', 'ARA-20261001-1', '2026-09-28', 'Alpha2', 0),
  ('TA', 'Shadowfront', 'SF1-20261002-1', '2026-09-28', 'Alpha3', 0),
  ('TA', 'Defend Trade Route', 'DTR-20260901-1', '2026-08-31', 'Alpha2', 1),
  ('TA', 'Shadowfront', 'SF1-20260904-1', '2026-08-31', 'Alpha2', 1);
INSERT INTO public.shadowfront_squads (guild, week_start, pseudo, squad, role, session_id) VALUES
  ('TA', '2026-09-28', 'Alpha3', 'squad1', 'participant', 'SF1-20261002-1'),
  ('TA', '2026-08-31', 'Alpha2', 'squad1', 'participant', 'SF1-20260904-1'),
  ('TA', '2026-10-05', 'Alpha2', 'squad2', 'participant', NULL);

-- ── Who may call them ────────────────────────────────────────────────────────
SELECT tests.login('t_admin_b');
SELECT tests.assert_raises($q$SELECT public.gm_delete_event_session('TA', 'ARMS RACE STAGE A', 'ARA-20261001-1')$q$,
                           'another guild''s admin cannot delete a session', '42501');
SELECT tests.assert_raises($q$SELECT public.gm_ban_member('TA', '7000002', 'Alpha2', NULL)$q$,
                           'nor ban one of its members', '42501');
SELECT tests.login('t_member_a');
SELECT tests.assert_raises($q$SELECT public.gm_update_member('TA', 'Alpha2', '{"role":"R4"}')$q$,
                           'a member cannot edit the roster', '42501');
SELECT tests.login_stale('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_clear_event_history('TA', ARRAY['Defend Trade Route'])$q$,
                           'a revoked session cannot write', '42501');
SELECT tests.anon();
SELECT tests.assert_raises($q$SELECT public.gm_add_member('TA', '{"pseudo":"X","uid":"7009999"}')$q$,
                           'anon cannot call them', '42501');
SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_create_migration_group('G', ARRAY['9001','9002'])$q$,
                           'a migration group is a super_admin act', '42501');

-- ── Reschedule: SvS moves with its war session and daily scores ──────────────
SELECT tests.assert_eq(public.gm_reschedule_event_session('TA', 'SvS', 'SVS-2026-W40', 'SVS-2026-W41', '2026-10-05T00:00:00Z')->>'session_id',
                       'SVS-2026-W41'::text, 'a reschedule returns the new session id');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT session_id || '/' || start_at::date FROM public.event_status WHERE guild = 'TA' AND event_name = 'SvS'),
                       'SVS-2026-W41/2026-10-05'::text, 'the status row moved');
SELECT tests.assert_eq((SELECT week_start::text FROM public.event_participants WHERE guild = 'TA' AND event_name = 'SvS'),
                       '2026-10-05'::text, 'the participants moved to the new week and id');
SELECT tests.assert_eq((SELECT count(*) FROM public.war_sessions WHERE guild = 'TA' AND session_id = 'SVS-2026-W41')::int, 1,
                       'the war session followed (owner decision 2)');
SELECT tests.assert_eq((SELECT score FROM public.event_daily_scores WHERE guild = 'TA' AND session_id = 'SVS-2026-W41'), 500::bigint,
                       'and its daily scores with it');

-- Shadowfront: squads follow; a squad collision rolls the whole move back.
SELECT tests.login('t_admin_a');
SELECT public.gm_reschedule_event_session('TA', 'Shadowfront Squad 1', 'SF1-20261002-1', 'SF1-20261003-1', '2026-10-03T18:00:00Z');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT session_id FROM public.shadowfront_squads WHERE guild = 'TA' AND pseudo = 'Alpha3'),
                       'SF1-20261003-1'::text, 'the Shadowfront squad followed its session');
INSERT INTO public.shadowfront_squads (guild, week_start, pseudo, squad, role, session_id) VALUES ('TA', '2026-10-12', 'Alpha3', 'squad2', 'participant', NULL);
SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_reschedule_event_session('TA', 'Shadowfront Squad 1', 'SF1-20261003-1', 'SF1-20261013-1', '2026-10-13T18:00:00Z')$q$,
                           'a move onto a week the player is already squadded in is refused', '23505');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT session_id || '/' || start_at::date FROM public.event_status WHERE guild = 'TA' AND event_name = 'Shadowfront Squad 1'),
                       'SF1-20261003-1/2026-10-03'::text, 'and nothing of it was applied');

-- ── Delete a session ─────────────────────────────────────────────────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq((public.gm_delete_event_session('TA', 'ARMS RACE STAGE A', 'ARA-20261001-1')->>'participants')::int, 1,
                       'a session delete removes its participants');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*) FROM public.event_status WHERE guild = 'TA' AND event_name = 'ARMS RACE STAGE A')::int, 0,
                       'and its status row');

-- ── Clear history spares running sessions (owner decision 3) ─────────────────
SELECT tests.login('t_admin_a');
SELECT public.gm_clear_event_history('TA', ARRAY['Shadowfront', 'Shadowfront Squad 1', 'Shadowfront Squad 2']);
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*) FROM public.event_participants WHERE guild = 'TA' AND event_name = 'Shadowfront' AND session_id = 'SF1-20260904-1')::int, 0,
                       'a finished Shadowfront session is cleared');
SELECT tests.assert_eq((SELECT count(*) FROM public.event_participants WHERE guild = 'TA' AND event_name = 'Shadowfront' AND session_id = 'SF1-20261003-1')::int, 1,
                       'the running session''s participants are spared');
SELECT tests.assert_eq((SELECT count(*) FROM public.shadowfront_squads WHERE guild = 'TA')::int, 3,
                       'the running squad and the squads being prepared are spared');
SELECT tests.assert_eq((SELECT count(*) FROM public.event_status WHERE guild = 'TA' AND event_name = 'Shadowfront Squad 1')::int, 1,
                       'so is the running session''s status');

-- ── Ban: the ban and the removal together ────────────────────────────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_ban_member('TA', '7000002', 'Alpha2', 'cheating')->>'removed', 'Alpha2'::text,
                       'a ban removes the member');
SELECT tests.assert_eq(public.gm_ban_member('TA', '7000002', 'Alpha2', NULL)->>'error', 'already_banned'::text,
                       'a second ban is refused, not duplicated');
SELECT tests.assert_raises($q$SELECT public.gm_ban_member('TA', '7000001', 'Alpha1', NULL)$q$,
                           'banning an R5 is refused');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT created_by FROM public.banned_players WHERE guild = 'TA' AND uid = '7000002'), 't_admin_a'::text,
                       'the author is the caller''s account');
SELECT tests.assert_eq((SELECT count(*) FROM public.banned_players WHERE guild = 'TA' AND uid = '7000001')::int, 0,
                       'and the refused R5 ban left no ban behind');

-- ── Add and update a member ──────────────────────────────────────────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq((public.gm_add_member('TA', '{"pseudo":"Newbie","uid":"7000009","role":"R2","overall_power":1500}')->'member'->>'pseudo'),
                       'Newbie'::text, 'a member is added');
SELECT tests.assert_raises($q$SELECT public.gm_add_member('TA', '{"pseudo":"Again","uid":"7000002"}')$q$,
                           'a banned UID cannot be added back');
SELECT tests.assert_eq(public.gm_update_member('TA', 'Newbie', '{"pseudo":"Veteran","glory_score":42}')->>'pseudo', 'Veteran'::text,
                       'a member is renamed');
SELECT tests.assert_eq(public.gm_update_member('TA', 'Veteran', '{"is_admin":true}')->>'error', 'bad_request'::text,
                       'an unknown field is refused');
SELECT tests.assert_raises($q$SELECT public.gm_update_member('TA', 'Veteran', '{"pseudo":"Alpha3"}')$q$,
                           'a rename onto a taken pseudo is refused', '23505');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*) FROM public.player_name_history WHERE guild = 'TA' AND old_pseudo = 'Newbie' AND new_pseudo = 'Veteran')::int, 1,
                       'the rename is in the name history');
SELECT tests.assert_eq((SELECT count(*) FROM public.player_name_history WHERE guild = 'TA' AND new_pseudo = 'Alpha3')::int, 0,
                       'the refused rename left no history row');
SELECT tests.assert_eq((SELECT score FROM public.event_participants WHERE guild = 'TA' AND event_name = 'Glory' AND pseudo = 'Veteran'), 42::bigint,
                       'a changed Glory is this week''s Glory entry');

-- ── OCR roster: all or nothing (owner decision 1) ────────────────────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_commit_ocr_roster('TA', 'overall_power',
        '[{"pseudo":"Alpha3","score":900}]', '[{"pseudo":"Dup","uid":"7000003","score":5}]', '{}')$q$,
                           'a refused row refuses the import');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT overall_power FROM public.guild_members WHERE guild = 'TA' AND pseudo = 'Alpha3'), 0::bigint,
                       'and the valid rows of it were not applied either');
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_commit_ocr_roster('TA', 'overall_power',
        '[{"pseudo":"Alpha3","score":900,"role":"R3"},{"pseudo":"Alpha1","score":1000,"role":"R2"}]',
        '[{"pseudo":"Fresh","uid":"7000010","score":5,"role":"R4"}]', ARRAY['Veteran'])
        - 'ok', '{"added": 1, "removed": 1, "updated": 2, "ranks_assigned": 2}'::jsonb, 'a valid import applies every part');
SELECT tests.assert_eq(public.gm_commit_ocr_roster('TA', 'role', '[]', '[]', '{}')->>'error', 'bad_request'::text,
                       'only the seven metric columns can be imported');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT role FROM public.guild_members WHERE guild = 'TA' AND pseudo = 'Alpha1'), 'R5'::text,
                       'an R5 keeps its rank whatever the OCR read');

-- ── OCR attendance ───────────────────────────────────────────────────────────
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_record_event_attendance('TA', 'Shadowfront', 'SF1-20261003-1', '2026-09-28',
        '[{"pseudo":"Alpha3"},{"pseudo":"Fresh","sub_present":true}]') - 'ok', '{"updated": 1, "inserted": 1}'::jsonb,
                       'attendance updates the existing row and creates the missing one');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT participated || '/' || sub_present FROM public.event_participants WHERE guild = 'TA' AND session_id = 'SF1-20261003-1' AND pseudo = 'Fresh'),
                       '1/true'::text, 'a reserve is recorded as such');

-- ── Migration group ──────────────────────────────────────────────────────────
SELECT tests.login('t_super');
SELECT tests.assert_eq(public.gm_create_migration_group('Season 2', ARRAY['9001', ' 9002', '9001'])->>'servers', '2'::text,
                       'a group is created with its distinct servers');
SELECT tests.assert_eq(public.gm_create_migration_group('Alone', ARRAY['9001'])->>'error', 'bad_request'::text,
                       'a group needs two servers');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*) FROM public.server_migration_groups WHERE name = 'Alone')::int, 0,
                       'and a refused group leaves nothing behind');

ROLLBACK;
