-- R-03 audit fix: gm-signal-crypto.js's verifyPreKeySignature() computed the
-- real Schnorr check into an unused variable and returned a tautology
-- (comparing a hash to itself) instead — it always returned true. Every
-- signed-prekey signature was accepted unverified, which breaks the
-- authenticity guarantee of the X3DH handshake (a forged prekey bundle would
-- have been accepted silently).
--
-- The fix replaces the hand-rolled scheme with real Ed25519 (via
-- @noble/curves), which needs a real Ed25519 signing keypair — not derived
-- from the existing X25519 identity key (no home-grown XEdDSA conversion).
-- This column carries its public half. Existing accounts keep their X25519
-- identity key (and therefore their safety number) unchanged; the client
-- republishes a fresh bundle with a newly generated signing key on next
-- Leader Hall load (see gm-leader-hall.js initSignalIdentity()).
--
-- Nullable: rows written by the old client before this migration ships have
-- no signing key yet. gm-signal-crypto.js treats a missing signing key as
-- "cannot verify" and refuses to establish a session (fails closed), never
-- as "skip verification".

ALTER TABLE public.e2ee_prekey_bundles
    ADD COLUMN IF NOT EXISTS identity_signing_key TEXT;

-- Replace gm_publish_e2ee_prekey_bundle with a 6-arg version (new param has
-- a default so already-deployed clients keep working while they roll out).
DROP FUNCTION IF EXISTS public.gm_publish_e2ee_prekey_bundle(text, text, text, integer, jsonb);

CREATE OR REPLACE FUNCTION public.gm_publish_e2ee_prekey_bundle(
    p_identity_key text,
    p_signed_prekey text,
    p_signed_prekey_sig text,
    p_registration_id integer,
    p_one_time_prekeys jsonb DEFAULT '[]'::jsonb,
    p_identity_signing_key text DEFAULT NULL
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

    INSERT INTO public.e2ee_prekey_bundles (
        account_id,
        identity_key,
        signed_prekey,
        signed_prekey_sig,
        registration_id,
        identity_signing_key,
        updated_at
    ) VALUES (
        v_caller_id,
        p_identity_key,
        p_signed_prekey,
        p_signed_prekey_sig,
        p_registration_id,
        p_identity_signing_key,
        now()
    )
    ON CONFLICT (account_id) DO UPDATE SET
        identity_key = EXCLUDED.identity_key,
        signed_prekey = EXCLUDED.signed_prekey,
        signed_prekey_sig = EXCLUDED.signed_prekey_sig,
        registration_id = EXCLUDED.registration_id,
        identity_signing_key = COALESCE(EXCLUDED.identity_signing_key, public.e2ee_prekey_bundles.identity_signing_key),
        updated_at = now();

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

REVOKE ALL ON FUNCTION public.gm_publish_e2ee_prekey_bundle(text, text, text, integer, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_publish_e2ee_prekey_bundle(text, text, text, integer, jsonb, text) TO authenticated;

-- gm_get_e2ee_prekey_bundle now also returns identity_signing_key so the
-- initiator can verify the signature against the right key.
DROP FUNCTION IF EXISTS public.gm_get_e2ee_prekey_bundle(text);

CREATE OR REPLACE FUNCTION public.gm_get_e2ee_prekey_bundle(p_target_account_id text)
RETURNS TABLE (
    account_id text,
    identity_key text,
    signed_prekey text,
    signed_prekey_sig text,
    registration_id integer,
    one_time_key_id integer,
    one_time_public_key text,
    identity_signing_key text
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
        v_otk_pub,
        b.identity_signing_key
    FROM public.e2ee_prekey_bundles b
    WHERE b.account_id = p_target_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_e2ee_prekey_bundle(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_e2ee_prekey_bundle(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
