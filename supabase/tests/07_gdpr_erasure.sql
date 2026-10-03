-- GDPR erasure (Art. 17): the operator can run it without a session, and it
-- leaves nothing that identifies the person.
BEGIN;
SELECT tests.fixture();
INSERT INTO public.player_absences (guild, pseudo, uid, start_date, end_date) VALUES ('TA', 'Alpha1', '7000001', current_date, current_date);
INSERT INTO public.system_audit_logs (level, service, message, guild, uid, pseudo) VALUES ('INFO', 'test', 'trace', 'TA', '7000001', 'Alpha1');

-- A browser caller of another guild is refused.
SELECT tests.login('t_admin_b');
SELECT tests.assert_raises($q$SELECT public.gm_erase_player('TA', '7000001')$q$, 'another guild cannot erase TA''s player', '42501');

-- The operator, with no JWT.
SELECT tests.logout();
SELECT tests.assert_eq(public.gm_erase_player('TA', '7000001') ->> 'ok', 'true'::text, 'the operator erases a player without a session');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_members WHERE uid = '7000001' OR pseudo = 'Alpha1')::int, 0,
                       'no roster row keeps the UID or the pseudonym');
SELECT tests.assert_eq((SELECT uid FROM public.accounts WHERE id = 't_member_a'), NULL::text, 'the claiming account no longer carries the UID');
SELECT tests.assert_eq((SELECT count(*) FROM public.player_absences WHERE uid = '7000001')::int, 0, 'absences are deleted');
SELECT tests.assert_eq((SELECT count(*) FROM public.system_audit_logs WHERE uid = '7000001' OR pseudo = 'Alpha1')::int, 0,
                       'the audit log no longer names the player');

-- Account erasure: super_admin only from a browser; the operator may.
SELECT tests.login('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_erase_account('t_member_a')$q$, 'a guild admin cannot erase an account', '42501');
SELECT tests.logout();
INSERT INTO auth.sessions (user_id) SELECT auth_user_id FROM public.accounts WHERE id = 't_member_a';
CREATE TEMP TABLE erased_auth AS SELECT auth_user_id AS id FROM public.accounts WHERE id = 't_member_a';
SELECT tests.assert_eq(public.gm_erase_account('t_member_a') ->> 'ok', 'true'::text, 'the operator erases an account');
SELECT tests.assert_eq((SELECT count(*) FROM public.accounts WHERE id = 't_member_a')::int, 0, 'the account is deleted');
SELECT tests.assert_eq((SELECT count(*) FROM auth.sessions WHERE user_id IN (SELECT id FROM erased_auth))::int, 0, 'its sessions are ended');
SELECT tests.assert_eq((SELECT count(*) FROM auth.users WHERE id IN (SELECT id FROM erased_auth))::int, 1,
                       'the sign-in record is kept (owner decision: auth.users is never deleted)');
SELECT tests.assert_eq((SELECT raw_app_meta_data ? 'account_id' FROM auth.users WHERE id IN (SELECT id FROM erased_auth)), false,
                       'and no longer names the account');

ROLLBACK;
