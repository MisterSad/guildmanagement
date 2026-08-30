-- ============================================================================
-- Fix player transfer authorization bug + guild-agnostic session collisions
-- ============================================================================
-- Bug 1 (regression, live in production): gm_transfer_guild_member calls
-- gm_remove_member_from_active_events / gm_add_member_to_active_events with
-- swapped positional arguments (pseudo, guild) instead of (guild, pseudo).
-- Both helpers gate on check_user_guild_write_access(p_guild), which with the
-- swap receives a pseudo string instead of a real guild id and always
-- RAISE EXCEPTIONs 'Access denied' for guild_admin/server_admin callers (the
-- only two roles that realistically use the instant-transfer button),
-- rolling back the entire transaction including the guild_members/accounts
-- updates that had already succeeded. Simply reordering the arguments is not
-- sufficient: check_user_guild_write_access requires write access to the
-- *target* guild, which a guild_admin never has for a sister guild by
-- design. The real fix is a dedicated internal helper
-- (gm_transfer_sync_related_rows) that performs the same active-event sync
-- without re-checking authorization the caller has already established.
--
-- Bug 2: event session ids (buildEventSessionId, src/core/config/events.ts)
-- and week_start values are guild-agnostic — e.g. every guild running SvS in
-- ISO week 34 gets the identical session_id 'SVS-2026-W34'. If a transferred
-- player already has a row under the target guild for the same
-- (event_name, session_id) or week_start, guild_members' ON UPDATE CASCADE
-- would try to re-parent the source guild's row onto a key that already
-- exists, raising a unique-constraint violation and failing the whole
-- transfer. gm_transfer_sync_related_rows resolves this up front by
-- dropping the source guild's colliding row (the target guild's own record
-- is the more current one) before the cascade fires.
--
-- Also promotes resolve_guild_transfer and gm_admin_request_transfer (the
-- approve/reject queue and the admin-initiated request-from-duplicate-UID
-- flow) into the canonical migration set — both exist and work in
-- production today but were only ever defined in supabase/migrations_archive
-- (pre "ADR-004 consolidation"), meaning a database re-provisioned from
-- supabase/migrations/ alone would be missing them. Rewritten (not copied
-- verbatim) to add the server_admin role branch neither archived version
-- had, and to use the correct resolved_at/resolved_by columns.
-- ============================================================================

-- 1. Internal helper: active-event sync + collision-safe history migration.
-- Not exposed to clients — callable only via PERFORM from other
-- SECURITY DEFINER functions in this file.
CREATE OR REPLACE FUNCTION public.gm_transfer_sync_related_rows(
    p_pseudo text,
    p_source_guild text,
    p_target_guild text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    -- Collision guard: drop source-guild rows that would collide with an
    -- existing target-guild row once ON UPDATE CASCADE re-parents them.
    DELETE FROM public.event_participants src
    WHERE src.guild = p_source_guild AND src.pseudo = p_pseudo
      AND EXISTS (
        SELECT 1 FROM public.event_participants tgt
        WHERE tgt.guild = p_target_guild
          AND tgt.pseudo = src.pseudo
          AND tgt.event_name = src.event_name
          AND tgt.session_id IS NOT DISTINCT FROM src.session_id
      );

    DELETE FROM public.shadowfront_squads src
    WHERE src.guild = p_source_guild AND src.pseudo = p_pseudo
      AND EXISTS (
        SELECT 1 FROM public.shadowfront_squads tgt
        WHERE tgt.guild = p_target_guild
          AND tgt.pseudo = src.pseudo
          AND tgt.week_start = src.week_start
      );

    DELETE FROM public.shadowfront_signups src
    WHERE src.guild = p_source_guild AND src.pseudo = p_pseudo
      AND EXISTS (
        SELECT 1 FROM public.shadowfront_signups tgt
        WHERE tgt.guild = p_target_guild
          AND tgt.pseudo = src.pseudo
          AND tgt.week_start = src.week_start
      );

    DELETE FROM public.weekly_scores src
    WHERE src.guild = p_source_guild AND src.pseudo = p_pseudo
      AND EXISTS (
        SELECT 1 FROM public.weekly_scores tgt
        WHERE tgt.guild = p_target_guild
          AND tgt.pseudo = src.pseudo
          AND tgt.week_start = src.week_start
      );

    -- Active-event sync (ported from gm_remove/add_member_to_active_events,
    -- without their check_user_guild_write_access gate — see header comment).
    -- Also fixes a latent scoping gap in the original DELETE: it never
    -- constrained s.guild, so it could match another guild's active session
    -- with the same guild-agnostic event_name+session_id.
    DELETE FROM public.event_participants ep
    USING public.event_status s
    WHERE ep.guild = p_source_guild
      AND ep.pseudo = p_pseudo
      AND ep.event_name = s.event_name
      AND ep.session_id = s.session_id
      AND s.guild = p_source_guild
      AND s.is_active = true;

    INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, created_at)
    SELECT p_target_guild, s.event_name, s.session_id, COALESCE(s.start_at::date, now()::date), p_pseudo, 0, now()
    FROM public.event_status s
    WHERE s.guild = p_target_guild AND s.is_active = true
    ON CONFLICT (guild, event_name, session_id, pseudo) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_transfer_sync_related_rows(text, text, text) FROM public, anon, authenticated;

-- 2. Fix gm_transfer_guild_member: use the new internal helper instead of
-- the public, self-authorizing RPCs; restore the uid-collision check
-- alongside the existing pseudo check.
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

    IF v_caller_role = 'server_admin' AND (v_caller_server IS NULL OR v_source_server <> v_caller_server OR v_target_server <> v_caller_server) THEN
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

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
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

-- 3. Promote + rewrite resolve_guild_transfer (the approve/reject queue).
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
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
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

-- 4. Promote + rewrite gm_admin_request_transfer (admin-initiated request
-- from the "UID already taken" dialog on manual add).
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

    IF v_role = 'server_admin' AND (v_caller_server IS NULL OR v_source_server <> v_caller_server OR v_target_server <> v_caller_server) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
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

REVOKE ALL ON FUNCTION public.gm_transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_transfer_guild_member(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.resolve_guild_transfer(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_guild_transfer(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.gm_admin_request_transfer(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_admin_request_transfer(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
