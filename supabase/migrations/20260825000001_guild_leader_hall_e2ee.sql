-- 20260825000001_guild_leader_hall_e2ee.sql
-- Workstream: Guild Leader Hall — E2EE 1:1 & Group Chat (Signal Protocol)
--
-- Provides tables, indexes, Security Definer RPCs, and RLS policies for:
-- 1. Prekey Bundles & One-Time Prekeys (Signal Protocol X3DH)
-- 2. Conversations (Global Lounge, 1:1 Direct, and Groups with R5/R4 access controls)
-- 3. Conversation Members & Roles
-- 4. E2EE Ciphertext Messages (Blind server relay)

-- 1. PREKEY BUNDLES TABLE
CREATE TABLE IF NOT EXISTS public.e2ee_prekey_bundles (
    account_id TEXT PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
    identity_key TEXT NOT NULL,
    signed_prekey TEXT NOT NULL,
    signed_prekey_sig TEXT NOT NULL,
    registration_id INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.e2ee_prekey_bundles ENABLE ROW LEVEL SECURITY;

-- 2. ONE-TIME PREKEYS TABLE
CREATE TABLE IF NOT EXISTS public.e2ee_one_time_prekeys (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    key_id INTEGER NOT NULL,
    public_key TEXT NOT NULL,
    is_used BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT e2ee_one_time_prekeys_acc_key UNIQUE (account_id, key_id)
);

ALTER TABLE public.e2ee_one_time_prekeys ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_e2ee_otk_acc_unused
    ON public.e2ee_one_time_prekeys (account_id)
    WHERE is_used = false;

-- 3. CONVERSATIONS TABLE
CREATE TABLE IF NOT EXISTS public.e2ee_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL CHECK (type IN ('global', 'direct', 'group')),
    title TEXT,
    created_by TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
    is_r5_only BOOLEAN NOT NULL DEFAULT false,
    server_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.e2ee_conversations ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_e2ee_conv_updated_at
    ON public.e2ee_conversations (updated_at DESC);

-- Seed permanent Global Leader Lounge (accessible by all leaders across all servers)
INSERT INTO public.e2ee_conversations (
    id,
    type,
    title,
    is_r5_only
) VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'global',
    'Global Leaders Lounge',
    false
) ON CONFLICT (id) DO UPDATE SET title = 'Global Leaders Lounge';

-- 4. CONVERSATION MEMBERS TABLE
CREATE TABLE IF NOT EXISTS public.e2ee_conversation_members (
    conversation_id UUID NOT NULL REFERENCES public.e2ee_conversations(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    guild TEXT REFERENCES public.guilds(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    group_role TEXT NOT NULL DEFAULT 'member' CHECK (group_role IN ('admin', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, account_id)
);

ALTER TABLE public.e2ee_conversation_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_e2ee_conv_members_acc
    ON public.e2ee_conversation_members (account_id);

-- 5. ENCRYPTED MESSAGES TABLE
CREATE TABLE IF NOT EXISTS public.e2ee_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES public.e2ee_conversations(id) ON DELETE CASCADE,
    sender_account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    sender_guild TEXT,
    sender_role TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    header_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    iv TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.e2ee_messages ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_e2ee_messages_conv_created
    ON public.e2ee_messages (conversation_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- ACCESS CONTROL HELPERS (SECURITY DEFINER, STABLE, SET search_path TO '')
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: verify caller is an authorized admin/leader (R5, R4, server_admin, super_admin)
CREATE OR REPLACE FUNCTION public.gm_is_leader_caller()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.accounts
        WHERE auth_user_id = auth.uid() AND status = 'active'
          AND role IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin')
    );
$$;

REVOKE ALL ON FUNCTION public.gm_is_leader_caller() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_is_leader_caller() TO authenticated;

-- Helper: verify caller is a member of the conversation, it's global lounge, or super_admin
CREATE OR REPLACE FUNCTION public.gm_can_access_e2ee_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.e2ee_conversations
        WHERE id = p_conversation_id AND type = 'global'
          AND public.gm_is_leader_caller()
    ) OR EXISTS (
        SELECT 1
        FROM public.e2ee_conversation_members m
        JOIN public.accounts a ON a.id = m.account_id
        WHERE m.conversation_id = p_conversation_id
          AND a.auth_user_id = auth.uid()
          AND a.status = 'active'
          AND a.role IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin')
    ) OR EXISTS (
        SELECT 1 FROM public.accounts
        WHERE auth_user_id = auth.uid() AND status = 'active' AND role = 'super_admin'
    );
$$;

REVOKE ALL ON FUNCTION public.gm_can_access_e2ee_conversation(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_can_access_e2ee_conversation(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY POLICIES
-- ─────────────────────────────────────────────────────────────────────────────

-- Prekey bundles: readable by all authenticated leaders, writable by own account only
CREATE POLICY e2ee_prekey_bundles_select ON public.e2ee_prekey_bundles
    FOR SELECT TO authenticated
    USING (public.gm_is_leader_caller());

CREATE POLICY e2ee_prekey_bundles_all ON public.e2ee_prekey_bundles
    FOR ALL TO authenticated
    USING (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

-- One-time prekeys: readable by leaders, writable by own account only
CREATE POLICY e2ee_one_time_prekeys_select ON public.e2ee_one_time_prekeys
    FOR SELECT TO authenticated
    USING (public.gm_is_leader_caller());

CREATE POLICY e2ee_one_time_prekeys_all ON public.e2ee_one_time_prekeys
    FOR ALL TO authenticated
    USING (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

-- Conversations: select permitted for members and global lounge
CREATE POLICY e2ee_conversations_select ON public.e2ee_conversations
    FOR SELECT TO authenticated
    USING (public.gm_can_access_e2ee_conversation(id));

-- Conversation members: select permitted for conversation members
CREATE POLICY e2ee_conversation_members_select ON public.e2ee_conversation_members
    FOR SELECT TO authenticated
    USING (public.gm_can_access_e2ee_conversation(conversation_id));

-- Messages: select and insert permitted for conversation members
CREATE POLICY e2ee_messages_select ON public.e2ee_messages
    FOR SELECT TO authenticated
    USING (public.gm_can_access_e2ee_conversation(conversation_id));

CREATE POLICY e2ee_messages_insert ON public.e2ee_messages
    FOR INSERT TO authenticated
    WITH CHECK (
        public.gm_can_access_e2ee_conversation(conversation_id)
        AND sender_account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC HELPERS
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Fetch Prekey Bundle for recipient + consume 1 One-Time Prekey atomically
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

-- 2. Create conversation (Direct or Group) with participants
CREATE OR REPLACE FUNCTION public.gm_create_e2ee_conversation(
    p_type text,
    p_title text DEFAULT NULL,
    p_is_r5_only boolean DEFAULT false,
    p_member_account_ids text[] DEFAULT '{}'::text[]
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
    v_new_conv_id uuid;
    v_mem_id text;
    v_mem_guild text;
    v_mem_role text;
    v_existing_conv_id uuid;
BEGIN
    -- Resolve caller account
    SELECT id, guild, role, server_number
    INTO v_caller_id, v_caller_guild, v_caller_role, v_caller_server
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    -- If creating R5-only group, caller must be R5 or super_admin
    IF p_is_r5_only AND v_caller_role NOT IN ('super_admin', 'R5', 'admin') THEN
        RAISE EXCEPTION 'forbidden: only R5 leaders or super_admin can create R5-only groups';
    END IF;

    -- For direct 1:1, check if conversation already exists between the 2 accounts
    IF p_type = 'direct' AND array_length(p_member_account_ids, 1) = 1 THEN
        SELECT m1.conversation_id INTO v_existing_conv_id
        FROM public.e2ee_conversation_members m1
        JOIN public.e2ee_conversation_members m2 ON m1.conversation_id = m2.conversation_id
        JOIN public.e2ee_conversations c ON c.id = m1.conversation_id
        WHERE c.type = 'direct'
          AND m1.account_id = v_caller_id
          AND m2.account_id = p_member_account_ids[1]
        LIMIT 1;

        IF v_existing_conv_id IS NOT NULL THEN
            RETURN v_existing_conv_id;
        END IF;
    END IF;

    -- Insert conversation
    INSERT INTO public.e2ee_conversations (
        type,
        title,
        created_by,
        is_r5_only,
        server_number
    ) VALUES (
        p_type,
        CASE WHEN p_type = 'group' THEN COALESCE(NULLIF(trim(p_title), ''), 'New Group') ELSE NULL END,
        v_caller_id,
        p_is_r5_only,
        v_caller_server
    ) RETURNING id INTO v_new_conv_id;

    -- Insert creator as admin member
    INSERT INTO public.e2ee_conversation_members (
        conversation_id,
        account_id,
        guild,
        role,
        group_role
    ) VALUES (
        v_new_conv_id,
        v_caller_id,
        v_caller_guild,
        v_caller_role,
        'admin'
    );

    -- Insert other members
    IF p_member_account_ids IS NOT NULL THEN
        FOREACH v_mem_id IN ARRAY p_member_account_ids
        LOOP
            IF v_mem_id <> v_caller_id THEN
                SELECT guild, role INTO v_mem_guild, v_mem_role
                FROM public.accounts
                WHERE id = v_mem_id AND status = 'active'
                  AND role IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin');

                IF v_mem_guild IS NOT NULL OR v_mem_role IN ('super_admin', 'server_admin') THEN
                    -- Check R5-only constraint
                    IF NOT p_is_r5_only OR v_mem_role IN ('R5', 'super_admin', 'admin') THEN
                        INSERT INTO public.e2ee_conversation_members (
                            conversation_id,
                            account_id,
                            guild,
                            role,
                            group_role
                        ) VALUES (
                            v_new_conv_id,
                            v_mem_id,
                            v_mem_guild,
                            v_mem_role,
                            'member'
                        ) ON CONFLICT DO NOTHING;
                    END IF;
                END IF;
            END IF;
        END LOOP;
    END IF;

    RETURN v_new_conv_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_create_e2ee_conversation(text, text, boolean, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_e2ee_conversation(text, text, boolean, text[]) TO authenticated;

-- Notify schema reload
NOTIFY pgrst, 'reload schema';
