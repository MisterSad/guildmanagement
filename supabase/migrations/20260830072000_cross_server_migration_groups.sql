-- ============================================================================
-- Cross-server migration groups
-- ============================================================================
-- New feature: the game periodically opens a limited-time window where a
-- cluster of servers are grouped together and players may migrate to any
-- guild within that cluster. Until now, every transfer path enforced a
-- strict same-server_number rule with no way to relax it.
--
-- Design (confirmed with the app owner):
--   - Only a super_admin can create/open/close a migration group — guild
--     admins cannot self-serve this.
--   - The link between servers is a time-boxed window (status open/closed),
--     not a permanent list — closing it turns off eligibility immediately,
--     matching the game's actual ponctual mechanic.
--
-- The four transfer-eligibility functions (gm_transfer_guild_member,
-- resolve_guild_transfer, gm_admin_request_transfer, request_guild_transfer)
-- already reject different-server transfers with error 'different_server'.
-- This migration relaxes that single check, in each of them, to also accept
-- source/target servers that belong to the same currently-open migration
-- group — same-server transfers are completely unaffected.
-- ============================================================================

-- 1. Schema
CREATE TABLE IF NOT EXISTS public.server_migration_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    created_by TEXT DEFAULT (COALESCE(auth.uid()::text, 'Admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.server_migration_group_servers (
    id BIGSERIAL PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.server_migration_groups(id) ON DELETE CASCADE,
    server_number TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT server_migration_group_servers_group_server_key UNIQUE (group_id, server_number)
);

CREATE INDEX IF NOT EXISTS idx_smgs_server_number ON public.server_migration_group_servers(server_number);
CREATE INDEX IF NOT EXISTS idx_smg_status ON public.server_migration_groups(status);

ALTER TABLE public.server_migration_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_migration_group_servers ENABLE ROW LEVEL SECURITY;

-- RLS mirrors the guilds table pattern: any admin role can read (needed by
-- the transfer dialogs to show eligible out-of-server targets), only
-- super_admin can write.
DROP POLICY IF EXISTS gm_smg_select ON public.server_migration_groups;
CREATE POLICY gm_smg_select ON public.server_migration_groups
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guilds());

DROP POLICY IF EXISTS gm_smg_write ON public.server_migration_groups;
CREATE POLICY gm_smg_write ON public.server_migration_groups
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS gm_smgs_select ON public.server_migration_group_servers;
CREATE POLICY gm_smgs_select ON public.server_migration_group_servers
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guilds());

DROP POLICY IF EXISTS gm_smgs_write ON public.server_migration_group_servers;
CREATE POLICY gm_smgs_write ON public.server_migration_group_servers
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

-- 2. Eligibility helper
CREATE OR REPLACE FUNCTION public.servers_in_open_migration_group(p_server_a text, p_server_b text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.server_migration_group_servers a
        JOIN public.server_migration_group_servers b ON a.group_id = b.group_id
        JOIN public.server_migration_groups g ON g.id = a.group_id
        WHERE g.status = 'open'
          AND a.server_number = p_server_a
          AND b.server_number = p_server_b
    );
$$;

REVOKE ALL ON FUNCTION public.servers_in_open_migration_group(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.servers_in_open_migration_group(text, text) TO authenticated;

-- 3. Extend the 4 transfer-eligibility functions.

-- 3a. request_guild_transfer (player self-service, portal)
CREATE OR REPLACE FUNCTION public.request_guild_transfer(p_uid text, p_target_guild text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
BEGIN
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF auth.uid() IS NOT NULL THEN
        IF NOT (
            public.is_super_admin() OR
            public.check_user_guild_access(v_source_guild) OR
            EXISTS (
                SELECT 1 FROM public.accounts a
                WHERE a.auth_user_id = auth.uid() AND (a.uid = p_uid OR a.id = p_uid) AND a.status = 'active'
            )
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL
       OR (v_source_server <> v_target_server AND NOT public.servers_in_open_migration_group(v_source_server, v_target_server)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_transfers WHERE uid = p_uid AND status = 'pending') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_pending');
    END IF;

    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status)
    VALUES (p_uid, v_pseudo, v_source_guild, p_target_guild, 'pending');

    RETURN jsonb_build_object('ok', true, 'message', 'transfer_requested');
END;
$$;

-- 3b. gm_transfer_guild_member (instant transfer, "Transfer Member" button)
CREATE OR REPLACE FUNCTION public.gm_transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_uid text;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_caller_role = 'super_admin' THEN
        IF p_pseudo IS NOT NULL AND p_pseudo <> '' THEN
            SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
            FROM public.guild_members
            WHERE uid = p_uid AND LOWER(pseudo) = LOWER(p_pseudo)
            ORDER BY created_at DESC
            LIMIT 1;
        ELSE
            SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
            FROM public.guild_members
            WHERE uid = p_uid
            ORDER BY created_at DESC
            LIMIT 1;
        END IF;
    ELSIF v_caller_role = 'server_admin' THEN
        SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
        FROM public.guild_members
        WHERE uid = p_uid
        ORDER BY created_at DESC
        LIMIT 1;
    ELSE
        -- guild_admin: source guild must match own guild strictly (no fallback)
        IF v_caller_guild IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
        END IF;
        SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
        FROM public.guild_members
        WHERE uid = p_uid
          AND guild = v_caller_guild;
    END IF;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    -- Verify caller scope over source guild
    IF v_caller_role = 'guild_admin' AND v_caller_guild <> v_source_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_caller_role = 'server_admin' AND (
        v_caller_server IS NULL
        OR v_source_server <> v_caller_server
        OR (v_target_server <> v_caller_server AND NOT public.servers_in_open_migration_group(v_caller_server, v_target_server))
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_source_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL
       OR (v_source_server <> v_target_server AND NOT public.servers_in_open_migration_group(v_source_server, v_target_server)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND uid = v_uid) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND LOWER(pseudo) = LOWER(v_pseudo)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    END IF;

    UPDATE public.guild_members
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND pseudo = v_pseudo
      AND guild = v_source_guild;

    UPDATE public.accounts
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND role = 'member';

    PERFORM public.gm_transfer_sync_related_rows(v_pseudo, v_source_guild, p_target_guild);

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$$;

-- 3c. resolve_guild_transfer (approve/reject queue) — also re-validates the
-- source/target server relationship at approval time, not just at request
-- time: a migration group can close between the request and its approval,
-- and a stale request must not silently succeed after the window ends.
CREATE OR REPLACE FUNCTION public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_server text;
    v_transfer public.guild_transfers%ROWTYPE;
    v_approve_source_server text;
    v_approve_target_server text;
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

    IF v_caller_role = 'guild_admin' AND v_caller_guild <> v_transfer.target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role = 'server_admin' THEN
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_transfer.target_guild;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR (
            v_target_server <> v_caller_server AND NOT public.servers_in_open_migration_group(v_caller_server, v_target_server)
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
        END IF;
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
$$;

-- 3d. gm_admin_request_transfer (admin-initiated request from the
-- "UID already taken" dialog on manual add).
CREATE OR REPLACE FUNCTION public.gm_admin_request_transfer(p_uid text, p_target_guild text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
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
        v_target := COALESCE(v_caller_guild, 'ALPHA');
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

    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status)
    VALUES (p_uid, v_pseudo, v_source_guild, v_target, 'pending')
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'transfer_id', v_new_id,
        'source_guild', v_source_guild,
        'target_guild', v_target
    );
END;
$$;

-- 4. gm_list_transfer_eligible_guilds: returns every guild the caller's
-- guild can transfer players to — same server, OR any server sharing an
-- open migration group with it. Used by showTransferMemberDialog and the
-- player portal's transfer-request guild picker so out-of-server options
-- (when a window is open) are clearly labelled, not silently mixed in.
CREATE OR REPLACE FUNCTION public.gm_list_transfer_eligible_guilds(p_guild text)
RETURNS TABLE(id text, server_number text, is_same_server boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    WITH src AS (
        SELECT server_number FROM public.guilds WHERE guilds.id = p_guild
    )
    SELECT g.id, g.server_number, (g.server_number = src.server_number) AS is_same_server
    FROM public.guilds g, src
    WHERE g.id <> p_guild
      AND src.server_number IS NOT NULL
      AND g.server_number IS NOT NULL
      AND (
        g.server_number = src.server_number
        OR public.servers_in_open_migration_group(src.server_number, g.server_number)
      )
    ORDER BY is_same_server DESC, g.id ASC;
$$;

REVOKE ALL ON FUNCTION public.gm_list_transfer_eligible_guilds(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_transfer_eligible_guilds(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
