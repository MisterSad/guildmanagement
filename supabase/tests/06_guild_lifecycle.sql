-- Renaming and deleting a guild (ADR-022): the tag moves everywhere, deletion
-- is explicit and complete, and nothing falls back to a real tenant.
BEGIN;
SELECT tests.fixture();
INSERT INTO public.guild_config (guild, key, value) VALUES ('TA', 'guild_tag', '[TA]'), ('TB', 'probe', 'b');
INSERT INTO public.event_participants (guild, event_name, pseudo, week_start, participated) VALUES ('TA', 'SvS', 'Alpha2', current_date, 1);

-- Rename: refused to a member and to a taken tag, then done by the guild admin.
SELECT tests.login('t_member_a');
SELECT tests.assert_eq(public.gm_rename_guild('TA', 'TZ') ->> 'error', 'unauthorized'::text, 'a member cannot rename the guild');
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_rename_guild('TA', 'TB') ->> 'error', 'tag_taken'::text, 'a taken tag is refused');
SELECT tests.assert_eq(public.gm_rename_guild('TA', 'tz') ->> 'ok', 'true'::text, 'the guild admin renames TA to TZ');

SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*) FROM public.guilds WHERE id IN ('TA', 'TZ'))::int, 1, 'one guild row, under the new tag');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members WHERE guild = 'TZ')::int, 3, 'the roster followed');
SELECT tests.assert_eq((SELECT count(*) FROM public.event_participants WHERE guild = 'TZ')::int, 1, 'participations followed');
SELECT tests.assert_eq((SELECT count(*) FROM public.accounts WHERE guild = 'TZ')::int, 2, 'the accounts followed');
SELECT tests.assert_eq((SELECT value FROM public.guild_config WHERE guild = 'TZ' AND key = 'guild_tag'), '[TZ]'::text, 'the display tag followed');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_tag_history WHERE guild = 'TZ' AND old_tag = 'TA')::int, 1, 'the rename is recorded');

-- Deleting: a direct DELETE that would orphan rows is refused; the purge is complete.
SELECT tests.assert_raises($q$DELETE FROM public.guilds WHERE id = 'TB'$q$, 'a direct delete of a non-empty guild is refused', '23503');
SELECT public.gm_purge_guild_data('TB');
SELECT tests.assert_eq((SELECT count(*) FROM public.guilds WHERE id = 'TB')::int, 0, 'the purge deletes the guild');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members WHERE guild = 'TB')::int
                     + (SELECT count(*) FROM public.guild_config WHERE guild = 'TB')::int
                     + (SELECT count(*) FROM public.accounts WHERE guild = 'TB')::int, 0, 'and everything carrying its tag');
SELECT tests.assert_eq((SELECT count(*) FROM public.accounts WHERE id = 't_server')::int, 1, 'a server admin of the same server survives');

-- An unresolved guild lists nothing: no fallback to a real tenant.
INSERT INTO public.guilds (id, server_number) VALUES ('ALPHA', '9001');
INSERT INTO public.event_participants (guild, event_name, pseudo, week_start, participated)
  SELECT 'ALPHA', 'SvS', 'Gamma1', current_date, 1 WHERE false;  -- shape only
SELECT tests.login('t_server');
SELECT tests.assert_eq((SELECT count(*) FROM public.gm_list_event_sessions(NULL))::int, 0,
                       'a server admin with no guild and no target lists nothing');

ROLLBACK;
