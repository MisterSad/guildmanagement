-- 20260825152000_guild_leader_hall_actions.sql
-- Workstream: Guild Leader Hall Actions (Leave Group, Delete Conversation, Block Leaders, Global Channels)

-- 1. BLOCKED ACCOUNTS TABLE
CREATE TABLE IF NOT EXISTS public.e2ee_blocked_accounts (
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    blocked_account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, blocked_account_id)
);

ALTER TABLE public.e2ee_blocked_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY e2ee_blocked_accounts_policy ON public.e2ee_blocked_accounts
    FOR ALL TO authenticated
    USING (
        account_id IN (
            SELECT id FROM public.accounts
            WHERE auth_user_id = auth.uid() AND status = 'active'
        )
    );

-- 2. SEED MULTIPLE GLOBAL CHANNELS (General, Diplomacy, SvS War Council)
INSERT INTO public.e2ee_conversations (
    id,
    type,
    title,
    is_r5_only
) VALUES 
    ('00000000-0000-0000-0000-000000000001'::uuid, 'global', 'Global Lounge', false),
    ('00000000-0000-0000-0000-000000000002'::uuid, 'global', 'Diplomacy & Treaties', false),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'global', 'SvS War Council', false)
ON CONFLICT (id) DO UPDATE SET 
    title = EXCLUDED.title,
    type = 'global';

-- 3. RPC: LEAVE GROUP CONVERSATION
CREATE OR REPLACE FUNCTION public.gm_leave_e2ee_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_count integer;
    v_type text;
BEGIN
    -- Resolve caller account
    SELECT id INTO v_caller_id
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'unauthorized';
    END IF;

    SELECT type INTO v_type
    FROM public.e2ee_conversations
    WHERE id = p_conversation_id;

    IF v_type = 'global' THEN
        RAISE EXCEPTION 'cannot leave global channels';
    END IF;

    -- Delete caller from members
    DELETE FROM public.e2ee_conversation_members
    WHERE conversation_id = p_conversation_id AND account_id = v_caller_id;

    -- If 0 members remaining, cleanup conversation
    SELECT count(*) INTO v_count
    FROM public.e2ee_conversation_members
    WHERE conversation_id = p_conversation_id;

    IF v_count = 0 THEN
        DELETE FROM public.e2ee_conversations
        WHERE id = p_conversation_id;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_leave_e2ee_conversation(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_leave_e2ee_conversation(uuid) TO authenticated;

-- 4. RPC: DELETE CONVERSATION
CREATE OR REPLACE FUNCTION public.gm_delete_e2ee_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_role text;
    v_type text;
    v_created_by text;
    v_is_member boolean;
BEGIN
    SELECT id, role INTO v_caller_id, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'unauthorized';
    END IF;

    SELECT type, created_by INTO v_type, v_created_by
    FROM public.e2ee_conversations
    WHERE id = p_conversation_id;

    IF v_type = 'global' AND v_caller_role <> 'super_admin' THEN
        RAISE EXCEPTION 'cannot delete global channels';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.e2ee_conversation_members
        WHERE conversation_id = p_conversation_id AND account_id = v_caller_id
    ) INTO v_is_member;

    IF NOT v_is_member AND v_caller_role <> 'super_admin' AND v_created_by <> v_caller_id THEN
        RAISE EXCEPTION 'forbidden';
    END IF;

    -- If direct 1:1, remove caller; if both removed or caller is creator/admin, delete conv
    IF v_type = 'direct' THEN
        DELETE FROM public.e2ee_conversation_members
        WHERE conversation_id = p_conversation_id AND account_id = v_caller_id;

        IF NOT EXISTS (SELECT 1 FROM public.e2ee_conversation_members WHERE conversation_id = p_conversation_id) THEN
            DELETE FROM public.e2ee_conversations WHERE id = p_conversation_id;
        END IF;
    ELSE
        -- If group and caller is creator or super_admin, cascade delete group
        IF v_created_by = v_caller_id OR v_caller_role = 'super_admin' THEN
            DELETE FROM public.e2ee_conversations WHERE id = p_conversation_id;
        ELSE
            -- Otherwise treat as leaving group
            DELETE FROM public.e2ee_conversation_members
            WHERE conversation_id = p_conversation_id AND account_id = v_caller_id;
        END IF;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_delete_e2ee_conversation(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_delete_e2ee_conversation(uuid) TO authenticated;

-- 5. RPC: BLOCK / UNBLOCK LEADER
CREATE OR REPLACE FUNCTION public.gm_toggle_block_leader(p_target_account_id text, p_block boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
BEGIN
    SELECT id INTO v_caller_id
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'unauthorized';
    END IF;

    IF p_block THEN
        INSERT INTO public.e2ee_blocked_accounts (account_id, blocked_account_id)
        VALUES (v_caller_id, p_target_account_id)
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.e2ee_blocked_accounts
        WHERE account_id = v_caller_id AND blocked_account_id = p_target_account_id;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_toggle_block_leader(text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_toggle_block_leader(text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
