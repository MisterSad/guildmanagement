-- Migration: 20260825170500_fix_e2ee_conv_members_guild_fk.sql
-- Description: Drop foreign key constraint on e2ee_conversation_members.guild to support super_admin accounts (where guild is NULL) and remove hardcoded 'FGF' fallback.

-- 1. Drop foreign key constraint on e2ee_conversation_members
ALTER TABLE public.e2ee_conversation_members
    DROP CONSTRAINT IF EXISTS e2ee_conversation_members_guild_fkey;

-- 2. Update gm_create_e2ee_conversation with nullable guild support
CREATE OR REPLACE FUNCTION public.gm_create_e2ee_conversation(
    p_type text,
    p_title text DEFAULT NULL,
    p_is_r5_only boolean DEFAULT false,
    p_member_account_ids text[] DEFAULT ARRAY[]::text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_auth_id uuid;
    v_caller_id text;
    v_caller_guild text;
    v_caller_role text;
    v_caller_server text;
    v_new_conv_id uuid;
    v_existing_conv_id uuid;
    v_mem_id text;
    v_mem_guild text;
    v_mem_role text;
BEGIN
    v_caller_auth_id := auth.uid();
    IF v_caller_auth_id IS NULL THEN
        RAISE EXCEPTION 'unauthenticated: valid JWT session required';
    END IF;

    -- Resolve caller
    SELECT id, guild, role, server_number
    INTO v_caller_id, v_caller_guild, v_caller_role, v_caller_server
    FROM public.accounts
    WHERE auth_user_id = v_caller_auth_id AND status = 'active'
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
        v_caller_guild,
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
                    v_mem_guild,
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

-- 3. Update gm_add_e2ee_group_member
CREATE OR REPLACE FUNCTION public.gm_add_e2ee_group_member(
    p_conversation_id uuid,
    p_account_ids text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_auth_id uuid;
    v_caller_id text;
    v_caller_role text;
    v_caller_group_role text;
    v_conv record;
    v_target_id text;
    v_target record;
BEGIN
    v_caller_auth_id := auth.uid();
    IF v_caller_auth_id IS NULL THEN
        RAISE EXCEPTION 'unauthenticated: valid JWT session required';
    END IF;

    SELECT id, role INTO v_caller_id, v_caller_role
    FROM public.accounts
    WHERE auth_user_id = v_caller_auth_id AND status = 'active'
    LIMIT 1;

    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'forbidden: caller is not an active account';
    END IF;

    SELECT * INTO v_conv
    FROM public.e2ee_conversations
    WHERE id = p_conversation_id;

    IF v_conv.id IS NULL OR v_conv.type <> 'group' THEN
        RAISE EXCEPTION 'invalid conversation: not an active group';
    END IF;

    SELECT group_role INTO v_caller_group_role
    FROM public.e2ee_conversation_members
    WHERE conversation_id = p_conversation_id AND account_id = v_caller_id;

    IF v_caller_role <> 'super_admin' AND (v_caller_group_role IS NULL OR v_caller_group_role <> 'admin') THEN
        RAISE EXCEPTION 'forbidden: only group admins or super admins can add members';
    END IF;

    FOREACH v_target_id IN ARRAY p_account_ids
    LOOP
        SELECT id, guild, role, status
        INTO v_target
        FROM public.accounts
        WHERE id = v_target_id AND status = 'active'
        LIMIT 1;

        IF v_target.id IS NOT NULL THEN
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
                v_target.guild,
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

-- Grant permissions
REVOKE ALL ON FUNCTION public.gm_create_e2ee_conversation(text, text, boolean, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_e2ee_conversation(text, text, boolean, text[]) TO authenticated;

REVOKE ALL ON FUNCTION public.gm_add_e2ee_group_member(uuid, text[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_add_e2ee_group_member(uuid, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK SQL:
-- ALTER TABLE public.e2ee_conversation_members ADD CONSTRAINT e2ee_conversation_members_guild_fkey FOREIGN KEY (guild) REFERENCES public.guilds(id) ON DELETE SET NULL;
