-- Fix populate_event_participants to correctly resolve tenant guild using auth.uid()
CREATE OR REPLACE FUNCTION public.populate_event_participants(
  p_event_name text,
  p_session_id text,
  p_week_start date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer;
  v_guild text;
BEGIN
  IF p_event_name IS NULL OR p_session_id IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'event_name, session_id et week_start sont requis';
  END IF;

  -- Resolve guild from accounts table for the current user
  SELECT guild INTO v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Fallback to event_status if not resolved
  IF v_guild IS NULL THEN
    SELECT guild INTO v_guild
    FROM event_status
    WHERE event_name = p_event_name AND session_id = p_session_id;
  END IF;

  -- Default to 'ALPHA' if still not found
  IF v_guild IS NULL THEN
    v_guild := 'ALPHA';
  END IF;

  WITH ins AS (
    INSERT INTO event_participants (event_name, week_start, session_id, pseudo, guild, participated, score)
    SELECT p_event_name, p_week_start, p_session_id, gm.pseudo, gm.guild, 0, NULL
    FROM guild_members gm
    WHERE gm.guild = v_guild
      AND NOT EXISTS (
        SELECT 1 FROM event_participants ep
        WHERE ep.event_name = p_event_name
          AND ep.session_id = p_session_id
          AND ep.pseudo = gm.pseudo
          AND ep.guild = gm.guild
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted_count FROM ins;

  RETURN inserted_count;
END;
$$;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
