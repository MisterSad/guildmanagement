-- A revoked session (session_version bumped) is refused everywhere.
BEGIN;
SELECT tests.fixture();

UPDATE public.accounts SET session_version = session_version + 1 WHERE id = 't_admin_a';

SELECT tests.login_stale('t_admin_a');
SELECT tests.assert_eq(public.gm_session_is_valid(), false, 'a token older than session_version is invalid');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members)::int, 0, 'a revoked session reads nothing');
SELECT tests.assert_raises($q$INSERT INTO public.guild_members (guild, pseudo) VALUES ('TA', 'Ghost')$q$,
                           'a revoked session cannot write', '42501');

SELECT tests.login('t_admin_a');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members)::int, 3, 'a fresh token works again');

-- An account that is no longer active reads nothing, whatever its token.
SELECT tests.logout();
UPDATE public.accounts SET status = 'pending' WHERE id = 't_admin_b';
SELECT tests.login('t_admin_b');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members)::int, 0, 'a non-active account reads nothing');

-- Revocation ends every GoTrue session and refresh token of the identity.
SELECT tests.logout();
INSERT INTO auth.sessions (user_id) SELECT auth_user_id FROM public.accounts WHERE id = 't_admin_c';
INSERT INTO auth.refresh_tokens (user_id, session_id)
  SELECT s.user_id::text, s.id FROM auth.sessions s JOIN public.accounts a ON a.auth_user_id = s.user_id WHERE a.id = 't_admin_c';
SELECT public.gm_revoke_auth_sessions((SELECT auth_user_id FROM public.accounts WHERE id = 't_admin_c'));
SELECT tests.assert_eq((SELECT count(*) FROM auth.sessions s JOIN public.accounts a ON a.auth_user_id = s.user_id WHERE a.id = 't_admin_c')::int, 0,
                       'gm_revoke_auth_sessions deletes the sessions');
SELECT tests.assert_eq((SELECT count(*) FROM auth.refresh_tokens r JOIN public.accounts a ON a.auth_user_id::text = r.user_id WHERE a.id = 't_admin_c')::int, 0,
                       'gm_revoke_auth_sessions deletes the refresh tokens');

ROLLBACK;
