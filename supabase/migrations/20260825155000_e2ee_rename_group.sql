-- 20260825155000_e2ee_rename_group.sql
-- Workstream: Allow Leaders to rename group discussions & R5 summits

CREATE OR REPLACE FUNCTION public.gm_rename_e2ee_conversation(
    p_conversation_id uuid,
    p_new_title text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_id text;
    v_caller_role text;
    v_clean_title text;
    v_conv RECORD;
    v_is_member boolean;
BEGIN
    SELECT id, role INTO v_caller_id, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    v_clean_title := trim(p_new_title);
    IF length(v_clean_title) < 2 OR length(v_clean_title) > 100 THEN
        RAISE EXCEPTION 'invalid title: must be between 2 and 100 characters';
    END IF;

    SELECT * INTO v_conv
    FROM public.e2ee_conversations
    WHERE id = p_conversation_id;

    IF v_conv IS NULL THEN
        RAISE EXCEPTION 'conversation not found';
    END IF;

    IF v_conv.type <> 'group' THEN
        RAISE EXCEPTION 'only group discussions and summits can be renamed';
    END IF;

    -- Check caller is member or creator or super_admin
    SELECT EXISTS (
        SELECT 1 FROM public.e2ee_conversation_members
        WHERE conversation_id = p_conversation_id AND account_id = v_caller_id
    ) INTO v_is_member;

    IF NOT v_is_member AND v_conv.created_by <> v_caller_id AND v_caller_role <> 'super_admin' THEN
        RAISE EXCEPTION 'forbidden: caller is not a member of this group';
    END IF;

    UPDATE public.e2ee_conversations
    SET title = v_clean_title,
        updated_at = now()
    WHERE id = p_conversation_id;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_rename_e2ee_conversation(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_rename_e2ee_conversation(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
