-- supabase/tests/_helpers.sql
--
-- Tooling for the SQL tests (audit QA-01, QA-02): they run against a database
-- built by scripts/replay-migrations.sh, never against production.
--
-- A test signs in the way PostgREST does: it sets request.jwt.claims and
-- switches to the `authenticated` role, so every policy, grant and
-- SECURITY DEFINER check runs exactly as it does for a browser.
--
--   SELECT tests.fixture();            -- two guilds, every role, a few members
--   SELECT tests.login('t_admin_a');   -- act as that account
--   ...queries...
--   SELECT tests.logout();             -- back to the migration owner
--
-- Each test file runs in one transaction that ends in ROLLBACK.

CREATE SCHEMA IF NOT EXISTS tests;
GRANT USAGE ON SCHEMA tests TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION tests.assert(p_ok boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'FAILED: %', p_what;
    END IF;
    RAISE NOTICE 'ok - %', p_what;
END;
$$;

CREATE OR REPLACE FUNCTION tests.assert_eq(p_got anyelement, p_want anyelement, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_got IS DISTINCT FROM p_want THEN
        RAISE EXCEPTION 'FAILED: % (got %, want %)', p_what, p_got, p_want;
    END IF;
    RAISE NOTICE 'ok - %', p_what;
END;
$$;

-- Runs p_sql and asserts it raises. p_sqlstate, when given, must match.
CREATE OR REPLACE FUNCTION tests.assert_raises(p_sql text, p_what text, p_sqlstate text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF p_sqlstate IS NOT NULL AND v_state <> p_sqlstate THEN
            RAISE EXCEPTION 'FAILED: % (raised %, want %)', p_what, v_state, p_sqlstate;
        END IF;
        RAISE NOTICE 'ok - %', p_what;
        RETURN;
    END;
    RAISE EXCEPTION 'FAILED: % (did not raise)', p_what;
END;
$$;

-- Number of rows a statement affects, run as the current role.
CREATE OR REPLACE FUNCTION tests.rows(p_sql text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
    v_n integer;
BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

-- Two guilds on one server (TA, TB) and one on another (TC); one account per
-- role, each with its sign-in identity; three roster members per guild.
CREATE OR REPLACE FUNCTION tests.fixture()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    r      record;
    v_auth uuid;
BEGIN
    INSERT INTO public.guilds (id, server_number) VALUES ('TA', '9001'), ('TB', '9001'), ('TC', '9002');

    FOR r IN SELECT * FROM (VALUES
        ('t_super',    'super_admin',  NULL, NULL,   NULL),
        ('t_server',   'server_admin', NULL, '9001', NULL),
        ('t_admin_a',  'guild_admin',  'TA', '9001', NULL),
        ('t_admin_b',  'guild_admin',  'TB', '9001', NULL),
        ('t_admin_c',  'guild_admin',  'TC', '9002', NULL),
        ('t_member_a', 'member',       'TA', '9001', '7000001')
    ) v(id, role, guild, server, player_uid) LOOP
        v_auth := gen_random_uuid();
        INSERT INTO auth.users (id, email, raw_app_meta_data)
        VALUES (v_auth, r.id || '@test.invalid', jsonb_build_object('account_id', r.id, 'session_version', 0));
        INSERT INTO public.accounts (id, role, guild, server_number, uid, status, auth_user_id, password_hash)
        VALUES (r.id, r.role, r.guild, r.server, r.player_uid, 'active', v_auth,
                extensions.crypt('test-password-' || r.id, extensions.gen_salt('bf', 4)));
    END LOOP;

    INSERT INTO public.guild_members (guild, pseudo, uid, role) VALUES
        ('TA', 'Alpha1', '7000001', 'R5'), ('TA', 'Alpha2', '7000002', 'R1'), ('TA', 'Alpha3', '7000003', 'R1'),
        ('TB', 'Beta1',  '7000101', 'R5'), ('TB', 'Beta2',  '7000102', 'R1'), ('TB', 'Beta3',  '7000103', 'R1'),
        ('TC', 'Gamma1', '7000201', 'R5');
END;
$$;

-- Acts as an account, the way PostgREST does for a browser request.
CREATE OR REPLACE FUNCTION tests.login(p_account text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_auth uuid;
    v_ver  integer;
BEGIN
    PERFORM set_config('role', 'postgres', true);
    SELECT a.auth_user_id, a.session_version INTO STRICT v_auth, v_ver
      FROM public.accounts a WHERE a.id = p_account;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_auth, 'role', 'authenticated',
        'app_metadata', jsonb_build_object('account_id', p_account, 'session_version', v_ver))::text, true);
    PERFORM set_config('role', 'authenticated', true);
END;
$$;

-- Acts with a token minted BEFORE the account's session_version was bumped.
CREATE OR REPLACE FUNCTION tests.login_stale(p_account text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_auth uuid;
    v_ver  integer;
BEGIN
    PERFORM set_config('role', 'postgres', true);
    SELECT a.auth_user_id, a.session_version INTO STRICT v_auth, v_ver
      FROM public.accounts a WHERE a.id = p_account;
    PERFORM set_config('request.jwt.claims', jsonb_build_object(
        'sub', v_auth, 'role', 'authenticated',
        'app_metadata', jsonb_build_object('account_id', p_account, 'session_version', v_ver - 1))::text, true);
    PERFORM set_config('role', 'authenticated', true);
END;
$$;

CREATE OR REPLACE FUNCTION tests.anon()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('role', 'postgres', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('role', 'anon', true);
END;
$$;

-- Back to the migration owner (an operator in the SQL editor: no JWT).
CREATE OR REPLACE FUNCTION tests.logout()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('role', 'postgres', true);
    PERFORM set_config('request.jwt.claims', '', true);
END;
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tests TO anon, authenticated, service_role;
