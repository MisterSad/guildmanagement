-- 20260825160000_e2ee_group_members_management.sql
-- Workstream: Add and Remove members from existing E2EE discussion groups and summits

-- 1. RPC: ADD MEMBERS TO EXISTING GROUP
CREATE OR REPLACE FUNCTION public.gm_add_e2ee_group_members(
    p_conversation_id uuid,
    p_account_ids text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_role text;
    v_conv RECORD;
    v_is_member boolean;
    v_target_id text;
    v_target RECORD;
BEGIN
    SELECT id, role INTO v_caller_id, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    SELECT * INTO v_conv
    FROM public.e2ee_conversations
    WHERE id = p_conversation_id;

    IF v_conv IS NULL THEN
        RAISE EXCEPTION 'conversation not found';
    END IF;

    IF v_conv.type <> 'group' THEN
        RAISE EXCEPTION 'members can only be added to group discussions or summits';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.e2ee_conversation_members
        WHERE conversation_id = p_conversation_id AND account_id = v_caller_id
    ) INTO v_is_member;

    IF NOT v_is_member AND v_conv.created_by <> v_caller_id AND v_caller_role <> 'super_admin' THEN
        RAISE EXCEPTION 'forbidden: caller cannot manage this group';
    END IF;

    FOREACH v_target_id IN ARRAY p_account_ids
    LOOP
        SELECT id, guild, role, status
        INTO v_target
        FROM public.accounts
        WHERE id = v_target_id AND status = 'active'
        LIMIT 1;

        IF v_target.id IS NOT NULL THEN
            -- If R5 only group, ensure target is R5 or super_admin
            IF v_conv.is_r5_only AND lower(v_target.role) NOT IN ('super_admin', 'r5', 'admin') THEN
                CONTINUE; -- skip non-R5
            END IF;

            INSERT INTO public.e2ee_conversation_members (
                conversation_id,
                account_id,
                guild,
                role,
                group_role
            ) VALUES (
                p_conversation_id,
                v_target.id,
                COALESCE(v_target.guild, 'FGF'),
                v_target.role,
                'member'
            )
            ON CONFLICT (conversation_id, account_id) DO NOTHING;
        END IF;
    END LOOP;

    UPDATE public.e2ee_conversations
    SET updated_at = now()
    WHERE id = p_conversation_id;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_add_e2ee_group_members(uuid, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_add_e2ee_group_members(uuid, text[]) TO authenticated;

-- 2. RPC: REMOVE A MEMBER FROM GROUP
CREATE OR REPLACE FUNCTION public.gm_remove_e2ee_group_member(
    p_conversation_id uuid,
    p_target_account_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_role text;
    v_conv RECORD;
    v_caller_group_role text;
    v_is_creator boolean;
    v_remaining_count integer;
BEGIN
    SELECT id, role INTO v_caller_id, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    SELECT * INTO v_conv
    FROM public.e2ee_conversations
    WHERE id = p_conversation_id;

    IF v_conv IS NULL THEN
        RAISE EXCEPTION 'conversation not found';
    END IF;

    IF v_conv.type <> 'group' THEN
        RAISE EXCEPTION 'only group members can be removed';
    END IF;

    SELECT group_role INTO v_caller_group_role
    FROM public.e2ee_conversation_members
    WHERE conversation_id = p_conversation_id AND account_id = v_caller_id;

    v_is_creator := (v_conv.created_by = v_caller_id);

    -- Caller can remove if they are creator, super_admin, group admin, or removing themselves
    IF NOT v_is_creator AND v_caller_role <> 'super_admin' AND v_caller_group_role <> 'admin' AND v_caller_id <> p_target_account_id THEN
        RAISE EXCEPTION 'forbidden: only group administrators can remove members';
    END IF;

    DELETE FROM public.e2ee_conversation_members
    WHERE conversation_id = p_conversation_id AND account_id = p_target_account_id;

    -- Count remaining members
    SELECT count(*) INTO v_remaining_count
    FROM public.e2ee_conversation_members
    WHERE conversation_id = p_conversation_id;

    IF v_remaining_count = 0 THEN
        DELETE FROM public.e2ee_conversations WHERE id = p_conversation_id;
    ELSE
        UPDATE public.e2ee_conversations SET updated_at = now() WHERE id = p_conversation_id;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_remove_e2ee_group_member(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_remove_e2ee_group_member(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
