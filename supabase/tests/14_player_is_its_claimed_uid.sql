-- SEC2-01: an account whose LOGIN ID equals another guild's player UID is not
-- that player. It used to be, through `a.uid = p_uid OR a.id = p_uid`, which
-- let a guild admin request that player's transfer into its own guild and read
-- their history, metrics and KPIs.
BEGIN;
SELECT tests.fixture();

-- The attacker: a guild admin of TB whose account id is Alpha2's UID (TA).
DO $seed$
DECLARE
    v_auth uuid := gen_random_uuid();
BEGIN
    INSERT INTO auth.users (id, email, raw_app_meta_data)
    VALUES (v_auth, '7000002@test.invalid', jsonb_build_object('account_id', '7000002', 'session_version', 0));
    INSERT INTO public.accounts (id, role, guild, server_number, uid, status, auth_user_id, password_hash)
    VALUES ('7000002', 'guild_admin', 'TB', '9001', NULL, 'active', v_auth,
            extensions.crypt('test-password-7000002', extensions.gen_salt('bf', 4)));
END
$seed$;

SELECT tests.login('7000002');
SELECT tests.assert_eq(public.request_guild_transfer('7000002', 'TB') ->> 'error', 'forbidden'::text,
                       'an account named after a player''s UID cannot request that player''s transfer');
SELECT tests.assert_eq(public.gm_personal_kpis('7000002') ->> 'error', 'forbidden'::text,
                       'nor read their KPIs');
SELECT tests.assert_eq(public.gm_get_player_metrics_history('7000002', 10) ->> 'error', 'forbidden'::text,
                       'nor their metrics history');
SELECT tests.assert_eq(public.gm_get_player_event_history('7000002', 10) ->> 'error', 'forbidden'::text,
                       'nor their event history');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT count(*)::int FROM public.guild_transfers WHERE uid = '7000002'), 0,
                       'no transfer request was filed for the victim');

-- The real player, whose account claimed UID 7000001, still can.
SELECT tests.login('t_member_a');
SELECT tests.assert((public.gm_personal_kpis('7000001') ->> 'error') IS DISTINCT FROM 'forbidden',
                    'a player still reads their own KPIs');
SELECT tests.assert_eq(public.request_guild_transfer('7000001', 'TB') ->> 'ok', 'true'::text,
                       'and still requests their own transfer');
SELECT tests.logout();

-- No function treats an account id as a player UID any more.
SELECT tests.assert_eq((SELECT count(*)::int FROM pg_proc p
                         WHERE p.pronamespace = 'public'::regnamespace
                           AND pg_get_functiondef(p.oid) ~ 'a\.id\s*=\s*p_uid'), 0,
                       'no function honours a.id = p_uid');

ROLLBACK;
