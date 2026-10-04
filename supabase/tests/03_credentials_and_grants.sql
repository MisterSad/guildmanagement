-- No credential column is readable from a browser (finding C0), and the
-- functions meant for the service role are out of a browser's reach.
BEGIN;
SELECT tests.fixture();

SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT password_hash FROM public.accounts$q$, 'authenticated cannot read password_hash', '42501');
SELECT tests.assert_raises($q$SELECT password_enc FROM public.accounts$q$, 'authenticated cannot read password_enc', '42501');
SELECT tests.assert_raises($q$SELECT gotrue_secret_enc FROM public.accounts$q$, 'authenticated cannot read gotrue_secret_enc', '42501');
SELECT tests.assert_raises($q$UPDATE public.accounts SET role = 'super_admin' WHERE id = 't_admin_a'$q$,
                           'an admin cannot promote itself', '42501');
SELECT tests.assert_raises($q$INSERT INTO public.accounts (id, role) VALUES ('t_forged', 'super_admin')$q$,
                           'an admin cannot create an account by table write', '42501');
SELECT tests.assert_eq((SELECT count(*) FROM public.accounts)::int, 1, 'a guild_admin reads only its own account');

SELECT tests.assert_raises($q$SELECT public.gm_purge_guild_data('TB')$q$, 'authenticated cannot purge a guild', '42501');
SELECT tests.assert_raises($q$SELECT public.gm_revoke_auth_sessions(gen_random_uuid())$q$, 'authenticated cannot revoke sessions', '42501');
SELECT tests.assert_raises($q$SELECT * FROM public.gm_verify_password('t_admin_b', 'x')$q$, 'authenticated cannot probe passwords', '42501');

SELECT tests.anon();
SELECT tests.assert_raises($q$SELECT id FROM public.accounts$q$, 'anon cannot read accounts', '42501');
SELECT tests.assert_raises($q$SELECT public.gm_can_read_guild_data('TA')$q$, 'anon cannot execute an authorisation helper', '42501');
SELECT tests.assert_raises($q$SELECT public.gm_erase_player('TA', '7000002')$q$, 'anon cannot erase a player', '42501');

ROLLBACK;
