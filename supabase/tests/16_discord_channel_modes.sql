-- discord_channel_modes: the per-channel rename-only switch of the Discord
-- screenshot reader. Deny-all to clients, read-only to service_role, and the
-- only accepted mode is rename_only.
BEGIN;
SELECT tests.fixture();

SELECT tests.logout();
INSERT INTO public.discord_channel_modes (channel_id, discord_server_id, mode)
VALUES ('1544654496536338542', '1525831969710014625', 'rename_only');
SELECT tests.assert_eq((SELECT count(*) FROM public.discord_channel_modes), 1::bigint, 'an operator configures a rename-only channel');

SELECT tests.assert_raises($q$INSERT INTO public.discord_channel_modes (channel_id, discord_server_id, mode)
                              VALUES ('1544654496536338543', '1525831969710014625', 'verify')$q$,
                           'an unknown mode is refused', '23514');
SELECT tests.assert_raises($q$INSERT INTO public.discord_channel_modes (channel_id, discord_server_id, mode)
                              VALUES ('not-a-snowflake', '1525831969710014625', 'rename_only')$q$,
                           'a channel id that is not a snowflake is refused', '23514');

SELECT tests.anon();
SELECT tests.assert_raises($q$SELECT * FROM public.discord_channel_modes$q$, 'anon cannot read channel modes', '42501');

SELECT tests.login('t_super');
SELECT tests.assert_raises($q$SELECT * FROM public.discord_channel_modes$q$, 'even a super admin cannot read them from the client', '42501');

SELECT tests.logout();
-- Production's service_role has BYPASSRLS (the replayed one does not), so the
-- read is pinned as a privilege; the writes are refused by the grant itself.
SELECT tests.assert(has_table_privilege('service_role', 'public.discord_channel_modes', 'SELECT'),
                    'service_role may read the mode');
SET LOCAL ROLE service_role;
SELECT tests.assert_raises($q$INSERT INTO public.discord_channel_modes (channel_id, discord_server_id, mode)
                              VALUES ('1544654496536338544', '1525831969710014625', 'rename_only')$q$,
                           'service_role cannot write a mode', '42501');
SELECT tests.assert_raises($q$DELETE FROM public.discord_channel_modes$q$, 'service_role cannot delete a mode', '42501');
RESET ROLE;
ROLLBACK;
