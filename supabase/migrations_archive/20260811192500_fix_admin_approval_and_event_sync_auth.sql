-- 20260811192500_fix_admin_approval_and_event_sync_auth.sql
--
-- Fixes:
-- 1. gm_approve_player_account: Remove invalid auth.uid() check inside service_role function.
--    The admin-accounts edge function already authenticates JWT & checks admin roles cryptographically.
--    Checking auth.uid() (which is null for service_role calls) caused "unauthorized" errors when approving members.
-- 2. gm_add_member_to_active_events & gm_populate_event_participants:
--    Use resilient identity lookup (auth_user_id = auth.uid() fallback to auth.jwt()->>'sub')
--    and allow execution when auth.uid() is null (service_role / internal SECURITY DEFINER calls).

-- 1. Fix gm_approve_player_account
CREATE OR REPLACE FUNCTION public.gm_approve_player_account(p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target_guild text;
  v_target_status text;
BEGIN
  SELECT guild, status INTO v_target_guild, v_target_status
  FROM public.accounts WHERE id = p_id;

  IF v_target_guild IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_target_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
  END IF;

  UPDATE public.accounts SET status = 'active' WHERE id = p_id;

  -- Auto-enroll approved player into active events of their guild
  PERFORM public.gm_add_member_to_active_events(p_id, v_target_guild);

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_approve_player_account(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_approve_player_account(text) TO service_role;

-- 2. Fix gm_add_member_to_active_events
CREATE OR REPLACE FUNCTION public.gm_add_member_to_active_events(
  p_pseudo text,
  p_guild text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_target_guild text;
  v_inserted integer;
BEGIN
  IF p_pseudo IS NULL OR p_pseudo = '' OR p_guild IS NULL OR p_guild = '' THEN
    RETURN 0;
  END IF;

  -- Check caller role when called directly via client JWT (auth.uid() present)
  IF auth.uid() IS NOT NULL THEN
    SELECT role INTO v_caller_role
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_caller_role IS NULL THEN
      SELECT role INTO v_caller_role
      FROM public.accounts
      WHERE auth_user_id::text = (auth.jwt()->>'sub');
    END IF;

    IF v_caller_role = 'member' THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  END IF;

  v_target_guild := UPPER(TRIM(p_guild));

  IF NOT EXISTS (
    SELECT 1 FROM public.guild_members
    WHERE guild = v_target_guild AND LOWER(TRIM(pseudo)) = LOWER(TRIM(p_pseudo))
  ) THEN
    RETURN 0;
  END IF;

  WITH ins AS (
    INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score)
    SELECT
      v_target_guild,
      es.event_name,
      es.session_id,
      (DATE_TRUNC('week', COALESCE(es.start_at, es.updated_at) AT TIME ZONE 'UTC'))::date,
      gm.pseudo,
      0,
      null
    FROM public.event_status es
    CROSS JOIN public.guild_members gm
    WHERE es.guild = v_target_guild
      AND es.is_active = true
      AND es.session_id IS NOT NULL
      AND LOWER(es.event_name) NOT LIKE '%shadowfront%'
      AND gm.guild = v_target_guild
      AND LOWER(TRIM(gm.pseudo)) = LOWER(TRIM(p_pseudo))
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  RETURN COALESCE(v_inserted, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_add_member_to_active_events(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_add_member_to_active_events(text, text) TO authenticated, service_role;

-- 3. Fix gm_populate_event_participants
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

  IF auth.uid() IS NOT NULL THEN
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_caller_role IS NULL THEN
      SELECT role, guild INTO v_caller_role, v_caller_guild
      FROM public.accounts
      WHERE auth_user_id::text = (auth.jwt()->>'sub');
    END IF;

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
  ELSE
    v_target_guild := COALESCE(UPPER(p_guild), 'ALPHA');
  END IF;

  -- 1. Remove unparticipated rows for pseudos no longer in this guild
  DELETE FROM public.event_participants ep
  WHERE ep.guild = v_target_guild
    AND ep.event_name = p_event_name
    AND ep.session_id = p_session_id
    AND COALESCE(ep.participated::text, '0') IN ('0', 'false')
    AND ep.score IS NULL
    AND COALESCE(ep.sub_present::text, '0') IN ('0', 'false')
    AND COALESCE(ep.appointed::text, '0') IN ('0', 'false')
    AND NOT EXISTS (
      SELECT 1 FROM public.guild_members gm
      WHERE gm.guild = v_target_guild
        AND LOWER(TRIM(gm.pseudo)) = LOWER(TRIM(ep.pseudo))
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
          AND LOWER(TRIM(ep.pseudo)) = LOWER(TRIM(gm.pseudo))
      )
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted_count FROM ins;

  RETURN COALESCE(inserted_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_populate_event_participants(text, text, date, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_populate_event_participants(text, text, date, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
