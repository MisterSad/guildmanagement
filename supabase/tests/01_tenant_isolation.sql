-- Tenant isolation, as a browser sees it (RLS + grants).
BEGIN;
SELECT tests.fixture();

-- A guild admin: its own guild, nothing else.
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members)::int, 3, 'guild_admin TA reads its 3 members');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members WHERE guild = 'TB')::int, 0, 'guild_admin TA reads nothing of TB');
SELECT tests.assert_raises($q$INSERT INTO public.guild_members (guild, pseudo) VALUES ('TB', 'Intruder')$q$,
                           'guild_admin TA cannot insert into TB', '42501');
SELECT tests.assert_eq(tests.rows($q$UPDATE public.guild_members SET role = 'R2' WHERE guild = 'TB'$q$), 0,
                       'guild_admin TA cannot update TB');
SELECT tests.assert_eq(tests.rows($q$DELETE FROM public.guild_members WHERE guild = 'TB'$q$), 0,
                       'guild_admin TA cannot delete from TB');
SELECT tests.assert_eq(tests.rows($q$UPDATE public.guild_members SET role = 'R2' WHERE guild = 'TA' AND pseudo = 'Alpha2'$q$), 1,
                       'guild_admin TA can update its own member');
SELECT tests.assert_raises($q$INSERT INTO public.guild_config (guild, key, value) VALUES ('TB', 'probe', 'x')$q$,
                           'guild_admin TA cannot write TB config', '42501');
SELECT tests.assert_raises($q$INSERT INTO public.event_participants (guild, event_name, pseudo, week_start) VALUES ('TB', 'SvS', 'Beta2', current_date)$q$,
                           'guild_admin TA cannot write TB participations', '42501');

-- A server admin: the guilds of its server.
SELECT tests.login('t_server');
SELECT tests.assert_eq((SELECT count(DISTINCT guild) FROM public.guild_members)::int, 2, 'server_admin 9001 reads TA and TB');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members WHERE guild = 'TC')::int, 0, 'server_admin 9001 reads nothing on server 9002');
SELECT tests.assert_raises($q$INSERT INTO public.guild_members (guild, pseudo) VALUES ('TC', 'Intruder')$q$,
                           'server_admin 9001 cannot write a guild of 9002', '42501');

-- A member: no write to the roster.
SELECT tests.login('t_member_a');
SELECT tests.assert_raises($q$INSERT INTO public.guild_members (guild, pseudo) VALUES ('TA', 'SelfAdded')$q$,
                           'a member cannot write the roster', '42501');

-- The super admin: everything.
SELECT tests.login('t_super');
SELECT tests.assert_eq((SELECT count(DISTINCT guild) FROM public.guild_members WHERE guild IN ('TA', 'TB', 'TC'))::int, 3, 'super_admin reads every guild');

ROLLBACK;
