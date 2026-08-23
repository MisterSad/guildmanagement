-- 20260823070000_auth_hardening.sql
-- Workstream W10: Auth hardening (bcrypt dual-read migration, rate limiting, lockout)

-- 1. Add auth hardening columns to accounts
ALTER TABLE public.accounts
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- 2. Modernize gm_check_login with dual-read and lockout defense
DROP FUNCTION IF EXISTS public.gm_check_login(text, text);
CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
RETURNS TABLE(canonical_id text, role text, status text, is_locked boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_acc record;
    v_is_match boolean := false;
    v_key text;
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

    -- Check if locked
    IF v_acc.locked_until IS NOT NULL AND v_acc.locked_until > now() THEN
        RETURN QUERY SELECT v_acc.id, v_acc.role, v_acc.status, true, 'account_locked'::text;
        RETURN;
    END IF;

    -- Step 1: Check password_hash (bcrypt) if set
    IF v_acc.password_hash IS NOT NULL AND v_acc.password_hash <> '' THEN
        v_is_match := (extensions.crypt(p_password, v_acc.password_hash) = v_acc.password_hash);
    END IF;

    -- Step 2: Fallback to password_enc (legacy dual-read) if not matched yet
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

        -- Lazy migration: upgrade password_hash to bcrypt on successful decrypt match
        IF v_is_match THEN
            UPDATE public.accounts
            SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
            WHERE id = v_acc.id;
        END IF;
    END IF;

    -- Handle outcome
    IF v_is_match THEN
        UPDATE public.accounts
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now()
        WHERE id = v_acc.id;

        RETURN QUERY SELECT v_acc.id, COALESCE(v_acc.role, 'member'), COALESCE(v_acc.status, 'active'), false, NULL::text;
        RETURN;
    ELSE
        -- Increment failed count and lock out after 5 consecutive failed attempts
        UPDATE public.accounts
        SET failed_login_count = v_acc.failed_login_count + 1,
            locked_until = CASE 
                WHEN v_acc.failed_login_count + 1 >= 5 THEN now() + interval '15 minutes'
                ELSE NULL
            END
        WHERE id = v_acc.id;

        RETURN QUERY SELECT v_acc.id, NULL::text, NULL::text, (v_acc.failed_login_count + 1 >= 5), 'invalid_credentials'::text;
        RETURN;
    END IF;
END;
$$;

-- 3. Grants hygiene
REVOKE ALL ON FUNCTION public.gm_check_login(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_check_login(text, text) TO service_role, authenticated;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
