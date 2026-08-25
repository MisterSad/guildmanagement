-- 20260825161000_leader_hall_tenant_access_audit.sql
-- Workstream: Guarantee all admins across all tenants have full access to Leader Hall & E2EE RPCs

-- 1. Helper: verify caller is an authorized admin/leader across all tenants
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

-- 2. Update conversation creation to permit all guild_admin & server_admin across all tenants
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
    SELECT id, guild, role, server_number
    INTO v_caller_id, v_caller_guild, v_caller_role, v_caller_server
    FROM public.accounts
    WHERE auth_user_id = auth.uid() AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RAISE EXCEPTION 'forbidden: caller is not an active guild leader';
    END IF;

    -- If creating R5-only group, caller must be super_admin, server_admin, guild_admin, R5, or admin
    IF p_is_r5_only AND v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'admin') THEN
        RAISE EXCEPTION 'forbidden: only R5 leaders or administrators can create R5 summits';
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
        COALESCE(v_caller_guild, 'FGF'),
        v_caller_role,
        'admin'
    );

    -- Insert participants
    FOREACH v_mem_id IN ARRAY p_member_account_ids
    LOOP
        IF v_mem_id <> v_caller_id THEN
            SELECT guild, role INTO v_mem_guild, v_mem_role
            FROM public.accounts
            WHERE id = v_mem_id AND status = 'active'
            LIMIT 1;

            IF v_mem_role IS NOT NULL THEN
                INSERT INTO public.e2ee_conversation_members (
                    conversation_id,
                    account_id,
                    guild,
                    role,
                    group_role
                ) VALUES (
                    v_new_conv_id,
                    v_mem_id,
                    COALESCE(v_mem_guild, 'FGF'),
                    v_mem_role,
                    'member'
                )
                ON CONFLICT (conversation_id, account_id) DO NOTHING;
            END IF;
        END IF;
    END LOOP;

    RETURN v_new_conv_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_create_e2ee_conversation(text, text, boolean, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_e2ee_conversation(text, text, boolean, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
