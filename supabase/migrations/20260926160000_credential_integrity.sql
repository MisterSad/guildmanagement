-- 20260926160000_credential_integrity.sql
-- Phase D1 of the Discord-authentication migration: credential integrity.
-- Contains NO Discord code and ships on its own. It must land BEFORE the
-- account-claim flow, because that flow reuses the password check as a one-time
-- proof of ownership -- a broken password check means a broken claim.
--
-- Three things, all verified against the live database before writing:
--
--   1. `gm_check_login`'s body is extracted into `gm_verify_password` so the
--      legacy login and the future claim RPC share ONE implementation.
--   2. `gm_reset_account_password` and `gm_admin_upsert` write only
--      `password_enc`, never `password_hash` -- while `gm_check_login` checks
--      `password_hash` FIRST. Consequence: after an admin resets a password,
--      the OLD password keeps working indefinitely.
--   3. Fixing (2) naively would be far worse than the bug. See the guard below.

-- ============================================================================
-- 1. Extract the password verification into its own function
-- ============================================================================
-- Verbatim body of the live `gm_check_login` (dual-read bcrypt -> pgp, lazy
-- bcrypt upgrade, atomic failure counter, exponential lockout), with the same
-- SECURITY DEFINER / search_path / lock_timeout / statement_timeout settings.
--
-- Why extract rather than let the claim RPC call `gm_check_login` directly:
-- naming. A function called "check_login" that is invoked by something which is
-- explicitly NOT a login is the kind of thing that grows a second, divergent
-- copy six months later. One implementation, two honest names.

CREATE OR REPLACE FUNCTION public.gm_verify_password(p_id text, p_password text)
RETURNS TABLE(canonical_id text, role text, status text, is_locked boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
SET lock_timeout TO '2s'
SET statement_timeout TO '5s'
AS $function$
DECLARE
    v_acc record;
    v_is_match boolean := false;
    v_key text;
    v_now_locked boolean;
BEGIN
    SELECT a.id, a.role, a.status, a.password_enc, a.password_hash, a.failed_login_count, a.locked_until
    INTO v_acc
    FROM public.accounts a
    WHERE LOWER(a.id) = LOWER(TRIM(p_id))
    LIMIT 1;

    IF v_acc.id IS NULL THEN
        RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, false, 'invalid_credentials'::text;
        RETURN;
    END IF;

    IF v_acc.locked_until IS NOT NULL AND v_acc.locked_until > now() THEN
        RETURN QUERY SELECT v_acc.id, v_acc.role, v_acc.status, true, 'account_locked'::text;
        RETURN;
    END IF;

    -- An account whose credentials were destroyed by the Discord claim flow has
    -- both columns NULL: it must never match, not even an empty password.
    IF (v_acc.password_hash IS NULL OR v_acc.password_hash = '')
       AND v_acc.password_enc IS NULL THEN
        RETURN QUERY SELECT v_acc.id, NULL::text, NULL::text, false, 'invalid_credentials'::text;
        RETURN;
    END IF;

    -- Step 1: bcrypt.
    IF v_acc.password_hash IS NOT NULL AND v_acc.password_hash <> '' THEN
        v_is_match := (extensions.crypt(p_password, v_acc.password_hash) = v_acc.password_hash);
    END IF;

    -- Step 2: legacy dual-read on the reversible copy.
    IF NOT v_is_match AND v_acc.password_enc IS NOT NULL THEN
        SELECT s.decrypted_secret INTO v_key
        FROM vault.decrypted_secrets s
        WHERE s.name = 'gm_accounts_key';

        IF v_key IS NOT NULL THEN
            BEGIN
                v_is_match := (extensions.pgp_sym_decrypt(v_acc.password_enc, v_key) = p_password);
            EXCEPTION WHEN OTHERS THEN
                v_is_match := false;
            END;
        END IF;

        -- Lazy migration to bcrypt on a successful legacy match.
        IF v_is_match THEN
            UPDATE public.accounts
            SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
            WHERE id = v_acc.id;
        END IF;
    END IF;

    IF v_is_match THEN
        UPDATE public.accounts
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now()
        WHERE id = v_acc.id;

        RETURN QUERY SELECT v_acc.id, COALESCE(v_acc.role, 'member'), COALESCE(v_acc.status, 'active'), false, NULL::text;
        RETURN;
    ELSE
        -- Atomic increment: never derived from the stale v_acc snapshot, so
        -- concurrent failures cannot lose a strike and evade the lockout.
        -- Exponential backoff (15/30/45/60 min) after 5 consecutive failures.
        UPDATE public.accounts
        SET failed_login_count = public.accounts.failed_login_count + 1,
            locked_until = CASE
                WHEN public.accounts.failed_login_count + 1 >= 5 THEN
                    now() + (interval '15 minutes' * LEAST(4, GREATEST(1, (public.accounts.failed_login_count + 1) / 5)))
                ELSE NULL
            END
        WHERE id = v_acc.id
        RETURNING COALESCE(locked_until > now(), false)
        INTO v_now_locked;

        RETURN QUERY SELECT v_acc.id, NULL::text, NULL::text, v_now_locked, 'invalid_credentials'::text;
        RETURN;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.gm_verify_password(text, text) IS
    'THE password verification. Single implementation shared by gm_check_login '
    '(the legacy login) and, during the Discord migration, the account-claim '
    'flow. Never add a second copy: the claim must inherit the exact same '
    'dual-read, lockout and timeout behaviour as the login it replaces.';

REVOKE ALL ON FUNCTION public.gm_verify_password(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_verify_password(text, text) TO service_role;

-- `gm_check_login` becomes a thin delegation. Its signature, grants and callers
-- (auth-login/index.ts:61) are unchanged.
CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
RETURNS TABLE(canonical_id text, role text, status text, is_locked boolean, error text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT * FROM public.gm_verify_password(p_id, p_password);
$function$;

REVOKE ALL ON FUNCTION public.gm_check_login(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_login(text, text) TO service_role;

-- ============================================================================
-- 2. gm_reset_account_password: write BOTH password columns
-- ============================================================================
-- The UPDATE wrote only `password_enc`, so the stale `password_hash` -- which
-- `gm_verify_password` checks first -- kept the OLD password working after a
-- reset. Both are now written, and the lockout counters are cleared: an admin
-- resetting a password for a locked-out user obviously intends to unlock them.
--
-- No empty-password guard is needed here: `length(p_password) < 6` is rejected
-- at the top of the function.

CREATE OR REPLACE FUNCTION public.gm_reset_account_password(p_id text, p_password text)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_role text;
    v_target_guild text;
    v_target_server text;
BEGIN
    IF p_id IS NULL OR p_password IS NULL OR length(p_password) < 6 THEN
        RETURN QUERY SELECT false, 'invalid_password'::text;
        RETURN;
    END IF;

    IF auth.uid() IS NOT NULL THEN
        SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
        INTO v_caller_role, v_caller_guild, v_caller_server
        FROM public.accounts a
        LEFT JOIN public.guilds g ON g.id = a.guild
        WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
        LIMIT 1;

        IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
            RETURN QUERY SELECT false, 'forbidden'::text;
            RETURN;
        END IF;

        IF v_caller_role <> 'super_admin' THEN
            SELECT a2.role, a2.guild, COALESCE(a2.server_number, g2.server_number)
            INTO v_target_role, v_target_guild, v_target_server
            FROM public.accounts a2
            LEFT JOIN public.guilds g2 ON g2.id = a2.guild
            WHERE LOWER(a2.id) = LOWER(p_id)
            LIMIT 1;

            IF v_target_role = 'super_admin' THEN
                RETURN QUERY SELECT false, 'forbidden'::text;
                RETURN;
            END IF;

            IF v_caller_role = 'server_admin' THEN
                IF v_caller_server IS NULL OR v_target_server IS NULL OR v_caller_server <> v_target_server THEN
                    RETURN QUERY SELECT false, 'forbidden'::text;
                    RETURN;
                END IF;
            ELSIF v_caller_role = 'guild_admin' THEN
                IF v_target_role = 'server_admin' OR v_caller_guild IS NULL OR v_target_guild IS NULL OR v_caller_guild <> v_target_guild THEN
                    RETURN QUERY SELECT false, 'forbidden'::text;
                    RETURN;
                END IF;
            END IF;
        END IF;
    END IF;

    UPDATE public.accounts
    SET password_enc = extensions.pgp_sym_encrypt(
          p_password,
          (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
        ),
        password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
        failed_login_count = 0,
        locked_until = NULL
    WHERE LOWER(id) = LOWER(p_id);

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'account_not_found'::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT true, NULL::text;
END;
$function$;

-- ============================================================================
-- 3. gm_admin_upsert: write BOTH columns, but NEVER on an empty password
-- ============================================================================
-- This is the dangerous one, and the guard matters more than the fix.
--
-- `src/core/auth/session.ts:225-280` has a four-step fallback chain for role
-- changes whose step 3 calls this function with `p_password: ''`. Today that
-- writes pgp_sym_encrypt('') into password_enc and leaves password_hash alone,
-- so the account keeps working via the stale bcrypt hash -- the very bug fixed
-- in section 2, accidentally acting as a safety net.
--
-- Adding `password_hash = crypt(p_password, ...)` without a guard would turn
-- every role change into "set this account's password to the empty string",
-- and `gm_verify_password` would accept it, because crypt('', hash) = hash.
-- That converts a latent "old password still works" bug into an active
-- "empty password works" hole.
--
-- So: an empty password means "do not touch either credential column". A
-- missing password on a NEW account is a caller bug and raises.

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(p_id text, p_password text, p_role text, p_guild text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_has_password boolean;
    v_key text;
BEGIN
    -- Internal authorization gate when called with an authenticated JWT
    -- (browser path). Service-role calls (admin-accounts Edge Function) are
    -- trusted: the Edge already enforced the caller's role and guild scope.
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

    v_has_password := (p_password IS NOT NULL AND length(TRIM(p_password)) > 0);

    -- Creating an account with no credential at all would produce a row nobody
    -- can ever sign in to. Callers that only mean to change a role must target
    -- an account that already exists.
    IF NOT v_has_password
       AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = TRIM(p_id)) THEN
        RAISE EXCEPTION 'password_required';
    END IF;

    IF v_has_password THEN
        SELECT s.decrypted_secret INTO v_key
        FROM vault.decrypted_secrets s
        WHERE s.name = 'gm_accounts_key';
    END IF;

    INSERT INTO public.accounts (id, role, password_enc, password_hash, guild, status, created_at)
    VALUES (
        TRIM(p_id),
        COALESCE(p_role, 'guild_admin'),
        CASE WHEN v_has_password THEN extensions.pgp_sym_encrypt(p_password, v_key) END,
        CASE WHEN v_has_password THEN extensions.crypt(p_password, extensions.gen_salt('bf', 10)) END,
        p_guild,
        'active',
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        role   = EXCLUDED.role,
        guild  = EXCLUDED.guild,
        status = 'active',
        -- An empty password leaves BOTH columns exactly as they were.
        password_enc  = CASE WHEN v_has_password THEN EXCLUDED.password_enc  ELSE public.accounts.password_enc  END,
        password_hash = CASE WHEN v_has_password THEN EXCLUDED.password_hash ELSE public.accounts.password_hash END;
END;
$function$;

COMMENT ON FUNCTION public.gm_admin_upsert(text, text, text, text) IS
    'Upserts an admin account. An empty p_password means "role/guild change '
    'only" and leaves password_enc and password_hash untouched -- callers do '
    'pass an empty password for role syncs, and writing a bcrypt hash of "" '
    'would make the empty string a valid password for that account.';

NOTIFY pgrst, 'reload schema';

/* ============================================================================
   ROLLBACK SQL (restores the pre-fix behaviour -- only if a regression is
   traced here; note that reverting re-opens the "old password still works
   after a reset" defect):

     DROP FUNCTION IF EXISTS public.gm_verify_password(text, text);
   ...then restore gm_check_login, gm_reset_account_password and
   gm_admin_upsert from 20260913120000_perf_and_resilience_fixes.sql,
   20260823060000_security_rpc_lockdown.sql and
   20260824090000_guard_gm_admin_upsert_service_calls.sql respectively.

   NOTE: gm_verify_password's lazy bcrypt upgrade already back-fills
   password_hash on every successful legacy login, and section 2 now does the
   same on every admin reset. Those back-fills are not undone by a rollback.
   ============================================================================ */
