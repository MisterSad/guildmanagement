-- Transfers: whoever asks for a move can no longer approve it.
--
-- Found 2026-09-30 while writing the transfers guide, confirmed on the live
-- definitions. `gm_admin_request_transfer` (the "Player ID already exists ->
-- Request Transfer" dialog) always files the request with the CALLER'S guild as
-- target, and `resolve_guild_transfer` let a guild_admin approve any pending
-- transfer whose target is their guild. So an officer could type the UID of any
-- player of another guild on the same server, request the transfer, and approve
-- it themselves: the player -- history, sanctions, portal account -- moved
-- without the losing guild ever being asked.
--
-- 1. `guild_transfers.requested_by` records who initiated the move: 'player'
--    (Player Portal, `request_guild_transfer`) or 'admin' (a pull). Existing
--    rows are players' by default: there were 0 pending rows when this shipped.
-- 2. The approver is the guild RECEIVING a player's request, and the guild
--    LOSING the player for an admin pull. The pulling guild may still withdraw
--    its own request (reject), never approve it. server_admin decides within
--    the approver guild's server (or an open migration group); super_admin
--    decides anything.
-- 3. Nothing writes to `guild_transfers` directly any more. A
--    `gm_authenticated_update` policy let a target guild's admins UPDATE pending
--    rows in place -- uid, source guild, status, and now requested_by -- which
--    would walk straight around (2). No client or Edge Function uses it (every
--    write goes through the SECURITY DEFINER RPCs), so the policy is dropped and
--    the API roles keep SELECT only. `anon` had Supabase's default ALL on the
--    table, held back by RLS alone; it now has nothing.
-- 4. `gm_admin_request_transfer` no longer falls back to 'ALPHA' when a
--    guild_admin has no guild: that was a real tenant (AGENTS.md: an
--    unresolved tenant fails visibly).
--
-- Both function bodies are production's as of 2026-09-30 with only the
-- commented blocks changed.

ALTER TABLE public.guild_transfers
    ADD COLUMN IF NOT EXISTS requested_by text NOT NULL DEFAULT 'player';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_transfers_requested_by_check') THEN
        ALTER TABLE public.guild_transfers
            ADD CONSTRAINT guild_transfers_requested_by_check CHECK (requested_by IN ('player', 'admin'));
    END IF;
END $$;

DROP POLICY IF EXISTS gm_authenticated_update ON public.guild_transfers;
REVOKE ALL ON public.guild_transfers FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.guild_transfers FROM authenticated;
GRANT SELECT ON public.guild_transfers TO authenticated;

CREATE OR REPLACE FUNCTION public.gm_admin_request_transfer(p_uid text, p_target_guild text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_new_id uuid;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_role IS NULL OR v_role = 'member' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- guild_admin requests into their own guild; super_admin and server_admin
    -- (who may not be bound to one guild) must pass an explicit target.
    IF v_role IN ('super_admin', 'server_admin') THEN
        IF p_target_guild IS NULL OR p_target_guild = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'missing_target_guild');
        END IF;
        v_target := UPPER(p_target_guild);
    ELSE
        -- No fallback: an account without a guild has no guild to pull into.
        -- This used to default to 'ALPHA', a real tenant.
        IF v_caller_guild IS NULL OR v_caller_guild = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
        v_target := v_caller_guild;
    END IF;

    IF v_role <> 'super_admin' AND NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    -- Find the player's current guild.
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF v_source_guild = v_target THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_target AND uid = p_uid) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_role = 'server_admin' AND (
        v_caller_server IS NULL
        OR v_source_server <> v_caller_server
        OR (v_target_server <> v_caller_server AND NOT public.servers_in_open_migration_group(v_caller_server, v_target_server))
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL
       OR (v_source_server <> v_target_server AND NOT public.servers_in_open_migration_group(v_source_server, v_target_server)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    -- One pending request per player at a time.
    IF EXISTS (
        SELECT 1 FROM public.guild_transfers
        WHERE uid = p_uid AND status = 'pending'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_pending');
    END IF;

    -- An admin pull: the guild the player is LEAVING approves it.
    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status, requested_by)
    VALUES (p_uid, v_pseudo, v_source_guild, v_target, 'pending', 'admin')
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'transfer_id', v_new_id,
        'source_guild', v_source_guild,
        'target_guild', v_target
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_server text;
    v_transfer public.guild_transfers%ROWTYPE;
    v_approve_source_server text;
    v_approve_target_server text;
    v_approver_guild text;
    v_approver_server text;
    v_is_approver boolean;
    v_is_requester boolean;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    SELECT * INTO v_transfer FROM public.guild_transfers
    WHERE id = p_transfer_id AND status = 'pending';

    IF v_transfer.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    END IF;

    -- Whoever asked for the move never decides it. A player's own request is
    -- decided by the guild RECEIVING them; an admin pull (requested_by =
    -- 'admin') by the guild the player is LEAVING. Before this, a guild admin
    -- could pull any player of another guild on the server and approve their
    -- own request, because the pull's target was always their own guild.
    v_approver_guild := CASE WHEN v_transfer.requested_by = 'admin'
                             THEN v_transfer.source_guild ELSE v_transfer.target_guild END;
    SELECT server_number INTO v_approver_server FROM public.guilds WHERE id = v_approver_guild;

    IF v_caller_role = 'super_admin' THEN
        v_is_approver := true;
        v_is_requester := false;
    ELSIF v_caller_role = 'server_admin' THEN
        v_is_approver := v_caller_server IS NOT NULL AND v_approver_server IS NOT NULL AND (
            v_approver_server = v_caller_server
            OR public.servers_in_open_migration_group(v_caller_server, v_approver_server));
        v_is_requester := false;
    ELSE
        v_is_approver := v_caller_guild = v_approver_guild;
        -- The pulling guild may withdraw its own request (reject), never approve it.
        v_is_requester := v_transfer.requested_by = 'admin' AND v_caller_guild = v_transfer.target_guild;
    END IF;

    IF NOT v_is_approver AND NOT (p_action = 'reject' AND v_is_requester) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_transfer.target_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF p_action = 'approve' THEN
        -- The player must still live in the source guild (stale approval guard).
        IF NOT EXISTS (
            SELECT 1 FROM public.guild_members
            WHERE uid = v_transfer.uid AND guild = v_transfer.source_guild
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'member_no_longer_in_source');
        END IF;

        IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_transfer.target_guild AND uid = v_transfer.uid) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
        END IF;
        IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_transfer.target_guild AND LOWER(pseudo) = LOWER(v_transfer.pseudo)) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
        END IF;

        SELECT server_number INTO v_approve_source_server FROM public.guilds WHERE id = v_transfer.source_guild;
        SELECT server_number INTO v_approve_target_server FROM public.guilds WHERE id = v_transfer.target_guild;
        IF v_approve_source_server IS NULL OR v_approve_target_server IS NULL
           OR (v_approve_source_server <> v_approve_target_server AND NOT public.servers_in_open_migration_group(v_approve_source_server, v_approve_target_server)) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'different_server');
        END IF;

        UPDATE public.guild_members
        SET guild = v_transfer.target_guild
        WHERE uid = v_transfer.uid
          AND guild = v_transfer.source_guild;

        UPDATE public.accounts
        SET guild = v_transfer.target_guild
        WHERE uid = v_transfer.uid
          AND role = 'member';

        PERFORM public.gm_transfer_sync_related_rows(v_transfer.pseudo, v_transfer.source_guild, v_transfer.target_guild);

        UPDATE public.guild_transfers
        SET status = 'approved',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'approved');

    ELSIF p_action = 'reject' THEN
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
$function$;

REVOKE ALL ON FUNCTION public.gm_admin_request_transfer(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_admin_request_transfer(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_guild_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_guild_transfer(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
