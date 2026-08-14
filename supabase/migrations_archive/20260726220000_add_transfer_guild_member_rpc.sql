-- Migration: Add transfer_guild_member RPC function
-- Allows admins to transfer a player from one guild to another within the same server number.
-- Preserves all historical records (weekly_scores, event_participants, sanctions) under their historical guild for tracking.

CREATE OR REPLACE FUNCTION public.transfer_guild_member(
    p_uid text,
    p_target_guild text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
BEGIN
    -- Get caller info
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Find the member
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    -- Check caller permission: R5 can transfer any, R4 can transfer only from their assigned guild
    IF v_caller_role <> 'R5' AND v_caller_guild <> v_source_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    -- Cannot transfer to the exact same guild
    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    -- Fetch server numbers for source and target guilds
    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    -- Validate target guild exists and is on the SAME server
    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    -- Check if target guild already has a member with the same pseudo
    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND LOWER(pseudo) = LOWER(v_pseudo)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    END IF;

    -- Perform the transfer on guild_members table
    UPDATE public.guild_members
    SET guild = p_target_guild
    WHERE uid = p_uid;

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.transfer_guild_member(text, text) TO authenticated;
