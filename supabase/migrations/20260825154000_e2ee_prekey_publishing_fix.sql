-- 20260825154000_e2ee_prekey_publishing_fix.sql
-- Workstream: Fix E2EE Prekey publishing, RLS permissions, and prekey retrieval

-- 1. Explicit RLS Policies for e2ee_prekey_bundles and e2ee_one_time_prekeys
DROP POLICY IF EXISTS e2ee_prekey_bundles_all ON public.e2ee_prekey_bundles;
DROP POLICY IF EXISTS e2ee_prekey_bundles_insert ON public.e2ee_prekey_bundles;
DROP POLICY IF EXISTS e2ee_prekey_bundles_update ON public.e2ee_prekey_bundles;

CREATE POLICY e2ee_prekey_bundles_insert ON public.e2ee_prekey_bundles
    FOR INSERT TO authenticated
    WITH CHECK (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY e2ee_prekey_bundles_update ON public.e2ee_prekey_bundles
    FOR UPDATE TO authenticated
    USING (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    )
    WITH CHECK (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

DROP POLICY IF EXISTS e2ee_one_time_prekeys_all ON public.e2ee_one_time_prekeys;
DROP POLICY IF EXISTS e2ee_one_time_prekeys_insert ON public.e2ee_one_time_prekeys;
DROP POLICY IF EXISTS e2ee_one_time_prekeys_update ON public.e2ee_one_time_prekeys;

CREATE POLICY e2ee_one_time_prekeys_insert ON public.e2ee_one_time_prekeys
    FOR INSERT TO authenticated
    WITH CHECK (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY e2ee_one_time_prekeys_update ON public.e2ee_one_time_prekeys
    FOR UPDATE TO authenticated
    USING (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    )
    WITH CHECK (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

-- 2. Secure RPC to publish prekey bundle atomically
CREATE OR REPLACE FUNCTION public.gm_publish_e2ee_prekey_bundle(
    p_identity_key text,
    p_signed_prekey text,
    p_signed_prekey_sig text,
    p_registration_id integer,
    p_one_time_prekeys jsonb DEFAULT '[]'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_otk jsonb;
BEGIN
    SELECT id INTO v_caller_id
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'forbidden: active account not found';
    END IF;

    -- Upsert prekey bundle
    INSERT INTO public.e2ee_prekey_bundles (
        account_id,
        identity_key,
        signed_prekey,
        signed_prekey_sig,
        registration_id,
        updated_at
    ) VALUES (
        v_caller_id,
        p_identity_key,
        p_signed_prekey,
        p_signed_prekey_sig,
        p_registration_id,
        now()
    )
    ON CONFLICT (account_id) DO UPDATE SET
        identity_key = EXCLUDED.identity_key,
        signed_prekey = EXCLUDED.signed_prekey,
        signed_prekey_sig = EXCLUDED.signed_prekey_sig,
        registration_id = EXCLUDED.registration_id,
        updated_at = now();

    -- Insert one-time prekeys if provided
    IF jsonb_array_length(p_one_time_prekeys) > 0 THEN
        FOR v_otk IN SELECT * FROM jsonb_array_elements(p_one_time_prekeys)
        LOOP
            INSERT INTO public.e2ee_one_time_prekeys (
                account_id,
                key_id,
                public_key,
                is_used
            ) VALUES (
                v_caller_id,
                (v_otk->>'key_id')::integer,
                v_otk->>'public_key',
                false
            )
            ON CONFLICT (account_id, key_id) DO UPDATE SET
                public_key = EXCLUDED.public_key,
                is_used = false;
        END LOOP;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_publish_e2ee_prekey_bundle(text, text, text, integer, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_publish_e2ee_prekey_bundle(text, text, text, integer, jsonb) TO authenticated;

-- 3. Enhance gm_get_e2ee_prekey_bundle to return cleanly
CREATE OR REPLACE FUNCTION public.gm_get_e2ee_prekey_bundle(p_target_account_id text)
RETURNS TABLE (
    account_id text,
    identity_key text,
    signed_prekey text,
    signed_prekey_sig text,
    registration_id integer,
    one_time_key_id integer,
    one_time_public_key text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_otk_id bigint;
    v_otk_key_id integer;
    v_otk_pub text;
BEGIN
    IF NOT public.gm_is_leader_caller() THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    -- Atomically select and mark one unused one-time prekey
    SELECT id, key_id, public_key
    INTO v_otk_id, v_otk_key_id, v_otk_pub
    FROM public.e2ee_one_time_prekeys
    WHERE account_id = p_target_account_id AND is_used = false
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_otk_id IS NOT NULL THEN
        UPDATE public.e2ee_one_time_prekeys
        SET is_used = true
        WHERE id = v_otk_id;
    END IF;

    RETURN QUERY
    SELECT 
        b.account_id,
        b.identity_key,
        b.signed_prekey,
        b.signed_prekey_sig,
        b.registration_id,
        v_otk_key_id,
        v_otk_pub
    FROM public.e2ee_prekey_bundles b
    WHERE b.account_id = p_target_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_e2ee_prekey_bundle(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_e2ee_prekey_bundle(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
