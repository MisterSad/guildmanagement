-- Migration: Add guild_transfers table and RPCs

CREATE TABLE IF NOT EXISTS public.guild_transfers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    uid text NOT NULL,
    pseudo text NOT NULL,
    source_guild text NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    target_guild text NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    created_at timestamptz DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Enable RLS
ALTER TABLE public.guild_transfers ENABLE ROW LEVEL SECURITY;

-- Admins can read transfers if their guild is either source or target
CREATE POLICY "Admins can view their guild transfers"
ON public.guild_transfers
FOR SELECT TO authenticated
USING (
    source_guild = (SELECT guild FROM public.accounts WHERE auth_user_id = auth.uid()) OR
    target_guild = (SELECT guild FROM public.accounts WHERE auth_user_id = auth.uid()) OR
    (SELECT role FROM public.accounts WHERE auth_user_id = auth.uid()) = 'R5'
);

-- Admins of the target guild (or R5) can update the transfer to approve/reject
CREATE POLICY "Target admins can update transfers"
ON public.guild_transfers
FOR UPDATE TO authenticated
USING (
    target_guild = (SELECT guild FROM public.accounts WHERE auth_user_id = auth.uid()) OR
    (SELECT role FROM public.accounts WHERE auth_user_id = auth.uid()) = 'R5'
);

-- Service role (edge functions) can insert/update everything, so no policy needed for that since it bypasses RLS

-- RPC for player to request transfer (called via member-portal edge function securely)
CREATE OR REPLACE FUNCTION public.request_guild_transfer(
    p_uid text,
    p_target_guild text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
BEGIN
    -- 1. Find the member's current guild
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    -- 2. Cannot transfer to the exact same guild
    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    -- 3. Fetch server numbers for source and target guilds
    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    -- 4. Check if there's already a pending transfer
    IF EXISTS (SELECT 1 FROM public.guild_transfers WHERE uid = p_uid AND status = 'pending') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_pending');
    END IF;

    -- 5. Insert transfer request
    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status)
    VALUES (p_uid, v_pseudo, v_source_guild, p_target_guild, 'pending');

    RETURN jsonb_build_object('ok', true, 'message', 'transfer_requested');
END;
$$;

-- RPC for admin to resolve (approve/reject) a transfer
CREATE OR REPLACE FUNCTION public.resolve_guild_transfer(
    p_transfer_id uuid,
    p_action text -- 'approve' or 'reject'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_transfer public.guild_transfers%ROWTYPE;
BEGIN
    -- Get caller info
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Get transfer record
    SELECT * INTO v_transfer FROM public.guild_transfers WHERE id = p_transfer_id AND status = 'pending';
    
    IF v_transfer.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    END IF;

    -- Check caller permission: R5 can resolve any, R4/admin can resolve only if they are the target guild
    IF v_caller_role <> 'R5' AND v_caller_guild <> v_transfer.target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF p_action = 'approve' THEN
        -- Check if target guild already has a member with the same pseudo (to prevent unique constraint error)
        IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_transfer.target_guild AND LOWER(pseudo) = LOWER(v_transfer.pseudo)) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
        END IF;

        -- Update guild_members
        UPDATE public.guild_members
        SET guild = v_transfer.target_guild
        WHERE uid = v_transfer.uid;

        -- Update transfer status
        UPDATE public.guild_transfers
        SET status = 'approved',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'approved');
        
    ELSIF p_action = 'reject' THEN
        -- Update transfer status
        UPDATE public.guild_transfers
        SET status = 'rejected',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'rejected');
    ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_guild_transfer(uuid, text) TO authenticated;
