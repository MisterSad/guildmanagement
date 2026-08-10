-- 20260811003000_fix_tenant_isolated_event_participants_indexes.sql
--
-- Problem: Legacy unique indexes on event_participants (e.g. (event_name, session_id, pseudo))
-- were defined across all guilds without the `guild` column. Since deterministic session IDs
-- (e.g. ARB-20260811, SVS-2026-W32) are identical across guilds, an existing row in OMEGA
-- blocked inserting the same player into ALPHA upon transfer due to index collision!
--
-- Solution:
-- 1. Drop all legacy global unique constraints and indexes on event_participants.
-- 2. Create tenant-isolated partial unique indexes including `guild`:
--    - idx_ep_tenant_session_unique ON event_participants (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL
--    - idx_ep_tenant_no_session_unique ON event_participants (guild, event_name, week_start, pseudo) WHERE session_id IS NULL
-- 3. Update ON CONFLICT clauses in gm_add_member_to_active_events & gm_populate_event_participants.
-- 4. Re-run backfill to immediately populate Dust and all transferred members into ALPHA's active events.

DO $$
BEGIN
    -- Drop legacy table constraints
    ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_event_name_week_start_pseudo_key;
    ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_event_name_session_id_pseudo_key;
    ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_guild_event_week_pseudo_key;
    ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_guild_event_session_pseudo_key;

    -- Drop legacy indexes
    DROP INDEX IF EXISTS public.event_participants_session_unique;
    DROP INDEX IF EXISTS public.event_participants_no_session_unique;
    DROP INDEX IF EXISTS public.idx_ep_tenant_session_unique;
    DROP INDEX IF EXISTS public.idx_ep_tenant_no_session_unique;

    -- Create clean tenant-isolated partial unique indexes
    CREATE UNIQUE INDEX idx_ep_tenant_session_unique
        ON public.event_participants (guild, event_name, session_id, pseudo)
        WHERE session_id IS NOT NULL;

    CREATE UNIQUE INDEX idx_ep_tenant_no_session_unique
        ON public.event_participants (guild, event_name, week_start, pseudo)
        WHERE session_id IS NULL;
END $$;

-- Update gm_add_member_to_active_events to use tenant-isolated index
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

-- Update gm_populate_event_participants
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
GRANT EXECUTE ON FUNCTION public.gm_populate_event_participants(text, text, date, text) TO authenticated;

-- Run immediate backfill for Dust and all members across all active events
DO $$
DECLARE
  r RECORD;
BEGIN
  -- Remove stale unparticipated rows for former guild members
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
        AND LOWER(TRIM(gm.pseudo)) = LOWER(TRIM(ep.pseudo))
    );

  -- Populate current guild members into their active events
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
