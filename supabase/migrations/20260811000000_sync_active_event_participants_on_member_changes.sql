-- 20260811000000_sync_active_event_participants_on_member_changes.sql
--
-- Problem: When a member is added, deleted, or transferred between guilds,
-- active (already-initiated) event sessions (SvS, GvG, DTR, Arms Race) were not
-- updating their participant lists. Transferred members remained in the old
-- guild's active events and were missing from the target guild's active events.
--
-- Solution:
-- 1. Helper RPC: gm_remove_member_from_active_events(p_pseudo, p_guild)
--    Removes unparticipated active event rows for a pseudo in a guild.
-- 2. Update gm_transfer_guild_member & resolve_guild_transfer:
--    - Remove unparticipated active event rows from source_guild
--    - Enroll transferred member into active events of target_guild
-- 3. Update gm_approve_player_account:
--    - Enroll newly approved player into active events of their guild
-- 4. Update gm_populate_event_participants:
--    - Ensure it also cleans up stale unparticipated rows for members no longer in the guild

CREATE OR REPLACE FUNCTION public.gm_remove_member_from_active_events(
  p_pseudo text,
  p_guild text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF p_pseudo IS NULL OR p_pseudo = '' OR p_guild IS NULL OR p_guild = '' THEN
    RETURN 0;
  END IF;

  WITH del AS (
    DELETE FROM public.event_participants ep
    USING public.event_status es
    WHERE ep.guild = p_guild
      AND LOWER(ep.pseudo) = LOWER(p_pseudo)
      AND ep.event_name = es.event_name
      AND ep.session_id = es.session_id
      AND es.guild = p_guild
      AND es.is_active = true
      AND COALESCE(ep.participated, 0) = 0
      AND ep.score IS NULL
      AND COALESCE(ep.sub_present, 0) = 0
      AND COALESCE(ep.appointed, 0) = 0
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM del;

  RETURN COALESCE(v_deleted, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_remove_member_from_active_events(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_remove_member_from_active_events(text, text) TO authenticated, service_role;

-- Update gm_transfer_guild_member to handle active sessions on transfer
CREATE OR REPLACE FUNCTION public.gm_transfer_guild_member(
  p_uid text,
  p_target_guild text,
  p_pseudo text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_uid text;
BEGIN
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid()
       OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

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
    ELSE
        SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
        FROM public.guild_members
        WHERE uid = p_uid
          AND guild = COALESCE(v_caller_guild, 'ALPHA');
    END IF;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF v_caller_role <> 'super_admin' AND v_caller_guild <> v_source_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_source_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND LOWER(pseudo) = LOWER(v_pseudo)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    END IF;

    -- Update member guild
    UPDATE public.guild_members
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND pseudo = v_pseudo
      AND guild = v_source_guild;

    -- Update account guild if player account exists
    UPDATE public.accounts
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND role = 'member';

    -- Clean up unparticipated active event rows in source guild
    PERFORM public.gm_remove_member_from_active_events(v_pseudo, v_source_guild);

    -- Auto-enroll member into active event sessions in target guild
    PERFORM public.gm_add_member_to_active_events(v_pseudo, p_target_guild);

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_transfer_guild_member(text, text, text) TO authenticated;

-- Update resolve_guild_transfer to sync active event participants
CREATE OR REPLACE FUNCTION public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_transfer public.guild_transfers%ROWTYPE;
BEGIN
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid()
       OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT * INTO v_transfer FROM public.guild_transfers
    WHERE id = p_transfer_id AND status = 'pending';

    IF v_transfer.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    END IF;

    IF v_caller_role <> 'super_admin' AND v_caller_guild <> v_transfer.target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_transfer.target_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF p_action = 'approve' THEN
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

        UPDATE public.guild_transfers
        SET status = 'approved', updated_at = NOW()
        WHERE id = p_transfer_id;

        -- Clean up unparticipated active event rows in source guild
        PERFORM public.gm_remove_member_from_active_events(v_transfer.pseudo, v_transfer.source_guild);

        -- Auto-enroll into target guild active sessions
        PERFORM public.gm_add_member_to_active_events(v_transfer.pseudo, v_transfer.target_guild);

        RETURN jsonb_build_object('ok', true, 'status', 'approved');
    ELSE
        UPDATE public.guild_transfers
        SET status = 'rejected', updated_at = NOW()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'rejected');
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_guild_transfer(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_guild_transfer(uuid, text) TO authenticated;

-- Update gm_approve_player_account to auto-enroll on approval
CREATE OR REPLACE FUNCTION public.gm_approve_player_account(p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role text;
  v_guild text;
  v_target_guild text;
  v_target_status text;
  v_target_uid text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  SELECT guild, status, uid INTO v_target_guild, v_target_status, v_target_uid
  FROM public.accounts WHERE id = p_id;

  IF v_target_guild IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_role <> 'super_admin' AND NOT (v_role = 'guild_admin' AND v_guild = v_target_guild) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  IF v_target_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
  END IF;

  UPDATE public.accounts SET status = 'active' WHERE id = p_id;

  -- Enroll approved player into active events of their guild
  PERFORM public.gm_add_member_to_active_events(p_id, v_target_guild);

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_approve_player_account(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_approve_player_account(text) TO service_role;

-- Update gm_populate_event_participants to clean stale unparticipated rows for deleted/transferred members
CREATE OR REPLACE FUNCTION public.gm_populate_event_participants(
  p_event_name text,
  p_session_id text,
  p_week_start date,
  p_guild text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  inserted_count integer;
  v_target_guild text;
  v_caller_role text;
  v_caller_guild text;
BEGIN
  IF p_event_name IS NULL OR p_session_id IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'event_name, session_id and week_start are required';
  END IF;

  SELECT role, guild INTO v_caller_role, v_caller_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_caller_role = 'guild_admin' THEN
    v_target_guild := COALESCE(v_caller_guild, 'ALPHA');
    IF UPPER(p_guild) <> v_target_guild THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  ELSE
    v_target_guild := COALESCE(UPPER(p_guild), 'ALPHA');
  END IF;

  -- 1. Remove stale unparticipated rows for pseudos no longer in this guild
  DELETE FROM public.event_participants ep
  WHERE ep.guild = v_target_guild
    AND ep.event_name = p_event_name
    AND ep.session_id = p_session_id
    AND COALESCE(ep.participated, 0) = 0
    AND ep.score IS NULL
    AND COALESCE(ep.sub_present, 0) = 0
    AND COALESCE(ep.appointed, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.guild_members gm
      WHERE gm.guild = v_target_guild
        AND LOWER(gm.pseudo) = LOWER(ep.pseudo)
    );

  -- 2. Insert missing current guild members into the active event session
  WITH ins AS (
    INSERT INTO public.event_participants (guild, event_name, week_start, session_id, pseudo, participated, score)
    SELECT v_target_guild, p_event_name, p_week_start, p_session_id, gm.pseudo, 0, null
    FROM public.guild_members gm
    WHERE gm.guild = v_target_guild
      AND NOT EXISTS (
        SELECT 1 FROM public.event_participants ep
        WHERE ep.guild = v_target_guild
          AND ep.event_name = p_event_name
          AND ep.session_id = p_session_id
          AND LOWER(ep.pseudo) = LOWER(gm.pseudo)
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted_count FROM ins;

  RETURN inserted_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_populate_event_participants(text, text, date, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_populate_event_participants(text, text, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
