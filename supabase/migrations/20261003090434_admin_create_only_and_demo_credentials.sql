-- 20261003090434_admin_create_only_and_demo_credentials.sql
--
-- Two account-takeover paths found by the 2026-10-03 audit (audit/06-securite.md,
-- SEC-01 and SEC-03), closed together because together they let any visitor
-- take any account.
--
-- 1. gm_admin_upsert overwrote existing accounts.
--    It ended in `ON CONFLICT (id) DO UPDATE SET role, guild, status, password`.
--    Its browser gate checked only the TARGET guild, never the target account,
--    and `authenticated` held EXECUTE. So any guild_admin could call it with the
--    super_admin's id, their own guild and a password of their choosing, and the
--    super_admin became a guild_admin they could sign in as. The admin-accounts
--    `create` action reached the same overwrite under the service role, where the
--    gate does not run at all, and handed the new password back.
--
--    Both of its callers (admin-accounts `create` and `approve-guild-request`)
--    mean "create": the front refuses a duplicate id before calling, and
--    gm_approve_guild_request refuses a taken admin_id. No caller needs the
--    update half, so it is removed rather than gated. The name is kept so the
--    deployed Edge Function and the generated types stay valid across the
--    deploy; the behaviour is create-only.
--
-- 2. The DEMO tenant shipped a guild_admin with a published password.
--    `DemoAdmin` (guild_admin) and `DemoPlayer` (member) had the password written
--    in 20260818081500 and in scripts/generate_demo_data.py, and the nightly
--    gm_reset_demo_tenant_data() re-wrote it every night at 03:00. That gave
--    anyone the first link of the chain above.
--    The reset now creates the two accounts WITHOUT a password and never touches
--    an existing one's password. A super_admin who wants to use them issues one
--    with admin-accounts `reset-password`; it survives the nightly reset.

-- ── 1. gm_admin_upsert: create-only, service role only ─────────────────────

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(p_id text, p_password text, p_role text, p_guild text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id  text := TRIM(p_id);
    v_key text;
BEGIN
    -- Browser callers no longer hold EXECUTE (revoked below). The gate stays as
    -- a second wall in case a future migration re-grants it.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.is_super_admin() THEN
            IF p_role IN ('super_admin', 'server_admin') THEN
                RAISE EXCEPTION 'forbidden';
            END IF;
            IF NOT public.check_user_guild_write_access(p_guild) THEN
                RAISE EXCEPTION 'Access denied';
            END IF;
        END IF;
    END IF;

    IF v_id IS NULL OR v_id = '' THEN
        RAISE EXCEPTION 'id_required';
    END IF;
    IF p_password IS NULL OR length(TRIM(p_password)) = 0 THEN
        RAISE EXCEPTION 'password_required';
    END IF;

    -- Case-insensitive, like sign-in. A concurrent create of the same id that
    -- slips past this check still fails on idx_accounts_lower_id with the same
    -- SQLSTATE, so the caller sees one error either way.
    IF EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(v_id)) THEN
        RAISE EXCEPTION 'account_exists' USING ERRCODE = 'unique_violation';
    END IF;

    SELECT s.decrypted_secret INTO v_key
    FROM vault.decrypted_secrets s
    WHERE s.name = 'gm_accounts_key';

    INSERT INTO public.accounts (id, role, password_enc, password_hash, guild, status, created_at)
    VALUES (
        v_id,
        COALESCE(p_role, 'guild_admin'),
        extensions.pgp_sym_encrypt(p_password, v_key),
        extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
        p_guild,
        'active',
        now()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_admin_upsert(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_admin_upsert(text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.gm_admin_upsert(text, text, text, text) IS
  'Create-only despite its name (since 20261003090434): raises 23505 account_exists when the id is taken, '
  'case-insensitively. Service role only; called by the admin-accounts Edge Function.';

-- ── 2. DEMO reset: no published password, existing passwords left alone ─────

DO $repair$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname = 'gm_reset_demo_tenant_data';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'gm_reset_demo_tenant_data() not found: cannot repair';
  END IF;

  IF v_def NOT LIKE '%demo1234%' AND v_def !~* 'password_enc\s*=\s*EXCLUDED\.password_enc' THEN
    RAISE NOTICE 'gm_reset_demo_tenant_data() already writes no demo password; nothing to repair';
    RETURN;
  END IF;

  -- New demo accounts get no password at all.
  v_def := regexp_replace(
    v_def,
    'extensions\.pgp_sym_encrypt\(\s*''demo1234''\s*,\s*\(SELECT s\.decrypted_secret FROM vault\.decrypted_secrets s WHERE s\.name = ''gm_accounts_key''\)\s*\)',
    'NULL',
    'gi'
  );
  -- Existing ones keep whatever password a super_admin issued.
  v_def := regexp_replace(
    v_def,
    ',\s*password_enc\s*=\s*EXCLUDED\.password_enc\s*;',
    ';',
    'gi'
  );
  v_def := replace(
    v_def,
    '-- Step 3: Ensure demo accounts are active, properly scoped, and initialized with demo passwords',
    '-- Step 3: Ensure demo accounts are active and properly scoped. They are never given a known password:'
      || E'\n    -- a super_admin issues one with admin-accounts reset-password, and this reset leaves it alone.'
  );

  IF v_def LIKE '%demo1234%' THEN
    RAISE EXCEPTION 'Refusing to re-create gm_reset_demo_tenant_data(): the demo password survived the rewrite';
  END IF;
  IF v_def ~* 'password_enc\s*=\s*EXCLUDED\.password_enc' THEN
    RAISE EXCEPTION 'Refusing to re-create gm_reset_demo_tenant_data(): it would still overwrite demo passwords';
  END IF;
  IF v_def NOT LIKE '%''DemoAdmin''%' OR v_def NOT LIKE '%''DemoPlayer''%' THEN
    RAISE EXCEPTION 'Refusing to re-create gm_reset_demo_tenant_data(): the demo accounts step went missing';
  END IF;

  EXECUTE v_def;
END
$repair$;

-- ── 3. Retire the published credentials now, and every session issued with them ──
-- session_version + 1 makes outstanding access tokens stale (gm_session_is_valid);
-- deleting the GoTrue sessions cascades to their refresh tokens, so none can be
-- refreshed into a new one.

DELETE FROM auth.sessions s
USING public.accounts a
WHERE a.auth_user_id = s.user_id
  AND a.id IN ('DemoAdmin', 'DemoPlayer');

UPDATE public.accounts
SET password_enc       = NULL,
    password_hash      = NULL,
    failed_login_count = 0,
    locked_until       = NULL,
    session_version    = session_version + 1
WHERE id IN ('DemoAdmin', 'DemoPlayer');

-- ── 4. Assert the end state ─────────────────────────────────────────────────

DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.gm_admin_upsert(text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.gm_admin_upsert(text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'gm_admin_upsert is still executable by a client role';
  END IF;
  IF pg_get_functiondef('public.gm_admin_upsert(text, text, text, text)'::regprocedure) ~* 'ON CONFLICT' THEN
    RAISE EXCEPTION 'gm_admin_upsert can still overwrite an existing account';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id IN ('DemoAdmin', 'DemoPlayer')
      AND (password_hash IS NOT NULL OR password_enc IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'a demo account still has a password';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
