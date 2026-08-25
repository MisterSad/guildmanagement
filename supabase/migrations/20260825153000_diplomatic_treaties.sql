-- 20260825153000_diplomatic_treaties.sql
-- Workstream: Diplomatic Treaties & Pacts Registry (Diplomacy & Treaties Space)

-- 1. DIPLOMATIC TREATIES TABLE
CREATE TABLE IF NOT EXISTS public.diplomatic_treaties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    guild_a TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    guild_a_server TEXT NOT NULL,
    guild_b TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    guild_b_server TEXT NOT NULL,
    treaty_type TEXT NOT NULL CHECK (treaty_type IN ('nap', 'mutual_defense', 'svs_coalition', 'ceasefire', 'custom')),
    terms TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ratified', 'revoked', 'expired')),
    created_by_account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    guild_a_signed_by TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
    guild_a_signed_at TIMESTAMPTZ,
    guild_b_signed_by TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
    guild_b_signed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.diplomatic_treaties ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_diplomatic_treaties_status
    ON public.diplomatic_treaties (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diplomatic_treaties_guilds
    ON public.diplomatic_treaties (guild_a, guild_b);

-- 2. ROW LEVEL SECURITY POLICIES
CREATE POLICY diplomatic_treaties_select ON public.diplomatic_treaties
    FOR SELECT TO authenticated
    USING (public.gm_is_leader_caller());

-- 3. RPC: CREATE PROPOSED TREATY
CREATE OR REPLACE FUNCTION public.gm_create_diplomatic_treaty(
    p_guild_b text,
    p_guild_b_server text,
    p_treaty_type text,
    p_terms text,
    p_expires_days integer DEFAULT 30
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_guild text;
    v_caller_role text;
    v_caller_server text;
    v_guild_a_server text;
    v_title text;
    v_new_id uuid;
    v_expires_at timestamptz;
BEGIN
    -- Resolve caller account
    SELECT id, guild, role, COALESCE(server_number, '1058')
    INTO v_caller_id, v_caller_guild, v_caller_role, v_caller_server
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    IF v_caller_guild IS NULL AND v_caller_role <> 'super_admin' THEN
        RAISE EXCEPTION 'caller must belong to a guild';
    END IF;

    v_caller_guild := COALESCE(v_caller_guild, 'ALPHA');
    v_guild_a_server := v_caller_server;

    -- Standard Title formatting: Treaty between [Guild A] ([Server A]) and [Guild B] ([Server B])
    v_title := 'Treaty between ' || v_caller_guild || ' (S' || v_guild_a_server || ') and ' || p_guild_b || ' (S' || p_guild_b_server || ')';

    IF p_expires_days > 0 THEN
        v_expires_at := now() + (p_expires_days || ' days')::interval;
    ELSE
        v_expires_at := NULL;
    END IF;

    -- Insert treaty with Guild A pre-signed by creator
    INSERT INTO public.diplomatic_treaties (
        title,
        guild_a,
        guild_a_server,
        guild_b,
        guild_b_server,
        treaty_type,
        terms,
        status,
        created_by_account_id,
        guild_a_signed_by,
        guild_a_signed_at,
        expires_at
    ) VALUES (
        v_title,
        v_caller_guild,
        v_guild_a_server,
        p_guild_b,
        p_guild_b_server,
        p_treaty_type,
        p_terms,
        'pending',
        v_caller_id,
        v_caller_id,
        now(),
        v_expires_at
    ) RETURNING id INTO v_new_id;

    RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_create_diplomatic_treaty(text, text, text, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_diplomatic_treaty(text, text, text, text, integer) TO authenticated;

-- 4. RPC: SIGN DIPLOMATIC TREATY
CREATE OR REPLACE FUNCTION public.gm_sign_diplomatic_treaty(p_treaty_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_guild text;
    v_caller_role text;
    v_treaty RECORD;
    v_all_signed boolean := false;
BEGIN
    SELECT id, guild, role
    INTO v_caller_id, v_caller_guild, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    SELECT * INTO v_treaty
    FROM public.diplomatic_treaties
    WHERE id = p_treaty_id;

    IF v_treaty IS NULL THEN
        RAISE EXCEPTION 'treaty not found';
    END IF;

    -- Sign for Guild A or Guild B
    IF v_caller_guild = v_treaty.guild_a OR v_caller_role = 'super_admin' THEN
        UPDATE public.diplomatic_treaties
        SET guild_a_signed_by = v_caller_id,
            guild_a_signed_at = now(),
            updated_at = now()
        WHERE id = p_treaty_id;
    ELSIF v_caller_guild = v_treaty.guild_b THEN
        UPDATE public.diplomatic_treaties
        SET guild_b_signed_by = v_caller_id,
            guild_b_signed_at = now(),
            updated_at = now()
        WHERE id = p_treaty_id;
    ELSE
        RAISE EXCEPTION 'forbidden: caller does not belong to either signatory guild';
    END IF;

    -- Check if both are now signed
    SELECT (guild_a_signed_by IS NOT NULL AND guild_b_signed_by IS NOT NULL) INTO v_all_signed
    FROM public.diplomatic_treaties
    WHERE id = p_treaty_id;

    IF v_all_signed THEN
        UPDATE public.diplomatic_treaties
        SET status = 'ratified',
            updated_at = now()
        WHERE id = p_treaty_id;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_sign_diplomatic_treaty(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_sign_diplomatic_treaty(uuid) TO authenticated;

-- 5. RPC: REVOKE DIPLOMATIC TREATY
CREATE OR REPLACE FUNCTION public.gm_revoke_diplomatic_treaty(p_treaty_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_guild text;
    v_caller_role text;
    v_treaty RECORD;
BEGIN
    SELECT id, guild, role
    INTO v_caller_id, v_caller_guild, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden';
    END IF;

    SELECT * INTO v_treaty
    FROM public.diplomatic_treaties
    WHERE id = p_treaty_id;

    IF v_treaty IS NULL THEN
        RAISE EXCEPTION 'treaty not found';
    END IF;

    IF v_caller_guild <> v_treaty.guild_a AND v_caller_guild <> v_treaty.guild_b AND v_caller_role <> 'super_admin' THEN
        RAISE EXCEPTION 'forbidden: caller is not a party to this treaty';
    END IF;

    UPDATE public.diplomatic_treaties
    SET status = 'revoked',
        updated_at = now()
    WHERE id = p_treaty_id;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_revoke_diplomatic_treaty(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_revoke_diplomatic_treaty(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
