-- The is_subscription_active stub is gone (20261004090000): the app is free
-- (ADR-015), and the always-true conjunct it added to 45 write policies hid
-- nothing but itself. The write rule is check_user_guild_write_access alone,
-- and it still decides: own guild yes, another guild no, a member no.
BEGIN;
SELECT tests.fixture();

SELECT tests.assert(to_regprocedure('public.is_subscription_active(text)') IS NULL,
                    'the stub no longer exists');
SELECT tests.assert_eq((SELECT count(*) FROM pg_policies
                         WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%subscription%')::int, 0,
                       'no policy mentions a subscription');

SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(tests.rows($q$INSERT INTO public.sanctions (guild, pseudo, comment) VALUES ('TA', 'Alpha2', 'late')$q$), 1,
                       'a guild admin still writes its own guild');
SELECT tests.assert_raises($q$INSERT INTO public.sanctions (guild, pseudo, comment) VALUES ('TB', 'Beta2', 'late')$q$,
                           'and still cannot write another guild', '42501');
SELECT tests.assert_eq(public.gm_require_guild_write('TA'), 'TA'::text,
                       'the shared RPC guard admits its own guild');
SELECT tests.assert_raises($q$SELECT public.gm_require_guild_write('TB')$q$,
                           'and refuses another', '42501');

SELECT tests.login('t_member_a');
SELECT tests.assert_raises($q$INSERT INTO public.sanctions (guild, pseudo, comment) VALUES ('TA', 'Alpha2', 'late')$q$,
                           'a member cannot write', '42501');
SELECT tests.logout();
ROLLBACK;
