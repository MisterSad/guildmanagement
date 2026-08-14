-- 20260811001000_fix_transfer_auto_enroll_authorization.sql
--
-- Fix: During guild transfers, gm_transfer_guild_member calls gm_add_member_to_active_events
-- for the target guild. Previously, gm_add_member_to_active_events restricted p_guild to the caller's
-- own guild (v_caller_guild), which caused an exception ('not_authorized') when a guild_admin of the
-- source guild transferred a player to the target guild.
--
-- Solution:
-- 1. Update gm_add_member_to_active_events: allow any authenticated admin (guild_admin or super_admin)
--    to enroll a member into p_guild's active events, provided the member actually belongs to p_guild
--    in guild_members.
-- 2. Update gm_remove_member_from_active_events: allow any authenticated admin to remove unparticipated
--    active event rows for a transferred member from the source guild.
-- 3. Ensure both 2-arg and 3-arg overloads of transfer_guild_member wrapper are defined and granted.

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

  SELECT role INTO v_caller_role
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_target_guild := UPPER(TRIM(p_guild));

  -- The member must belong to the target guild in guild_members.
  IF NOT EXISTS (
    SELECT 1 FROM public.guild_members
    WHERE guild = v_target_guild AND LOWER(pseudo) = LOWER(p_pseudo)
  ) THEN
    RETURN 0;
  END IF;

  -- Enroll into every active session of the target guild (skipping Shadowfront)
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
      AND LOWER(gm.pseudo) = LOWER(p_pseudo)
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  RETURN COALESCE(v_inserted, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_add_member_to_active_events(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_add_member_to_active_events(text, text) TO authenticated, service_role;

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
  v_caller_role text;
  v_deleted integer;
BEGIN
  IF p_pseudo IS NULL OR p_pseudo = '' OR p_guild IS NULL OR p_guild = '' THEN
    RETURN 0;
  END IF;

  SELECT role INTO v_caller_role
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH del AS (
    DELETE FROM public.event_participants ep
    USING public.event_status es
    WHERE ep.guild = UPPER(TRIM(p_guild))
      AND LOWER(ep.pseudo) = LOWER(p_pseudo)
      AND ep.event_name = es.event_name
      AND ep.session_id = es.session_id
      AND es.guild = UPPER(TRIM(p_guild))
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

-- Overload wrappers for transfer_guild_member
CREATE OR REPLACE FUNCTION public.transfer_guild_member(
  p_uid text,
  p_target_guild text,
  p_pseudo text DEFAULT null
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.gm_transfer_guild_member(p_uid, p_target_guild, p_pseudo);
$$;

CREATE OR REPLACE FUNCTION public.transfer_guild_member(
  p_uid text,
  p_target_guild text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.gm_transfer_guild_member(p_uid, p_target_guild, null);
$$;

REVOKE ALL ON FUNCTION public.transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.transfer_guild_member(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.transfer_guild_member(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.transfer_guild_member(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
