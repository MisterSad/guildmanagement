-- 20260811002000_backfill_active_events_for_all_members.sql
--
-- Backfill: Ensure all current guild members (including recently transferred players like Dust)
-- are populated into their guild's active (ongoing) event sessions, and remove unparticipated
-- active event rows from former guilds.

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
      AND COALESCE(ep.participated::text, '0') IN ('0', 'false')
      AND ep.score IS NULL
      AND COALESCE(ep.sub_present::text, '0') IN ('0', 'false')
      AND COALESCE(ep.appointed::text, '0') IN ('0', 'false')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM del;

  RETURN COALESCE(v_deleted, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_remove_member_from_active_events(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_remove_member_from_active_events(text, text) TO authenticated, service_role;

DO $$
DECLARE
  r RECORD;
BEGIN
  -- 1. Remove unparticipated active event rows for members who no longer belong to that guild
  DELETE FROM public.event_participants ep
  USING public.event_status es
  WHERE ep.guild = es.guild
    AND ep.event_name = es.event_name
    AND ep.session_id = es.session_id
    AND es.is_active = true
    AND COALESCE(ep.participated::text, '0') IN ('0', 'false')
    AND ep.score IS NULL
    AND COALESCE(ep.sub_present::text, '0') IN ('0', 'false')
    AND COALESCE(ep.appointed::text, '0') IN ('0', 'false')
    AND NOT EXISTS (
      SELECT 1 FROM public.guild_members gm
      WHERE gm.guild = ep.guild
        AND LOWER(gm.pseudo) = LOWER(ep.pseudo)
    );

  -- 2. Populate all current guild members into their guild's active events
  FOR r IN
    SELECT DISTINCT gm.pseudo, gm.guild
    FROM public.guild_members gm
  LOOP
    BEGIN
      PERFORM public.gm_add_member_to_active_events(r.pseudo, r.guild);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
