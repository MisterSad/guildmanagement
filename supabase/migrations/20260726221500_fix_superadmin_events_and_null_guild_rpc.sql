-- Migration: Fix Super Admin event launch and NULL guild handling in RPCs and policies

-- 1. Update is_subscription_active to always return true for Super Admin (R5)
CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  -- Super Admin (R5) is never restricted by subscription expiration
  SELECT role INTO v_role
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  IF v_role = 'R5' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(
    (SELECT
       CASE
         WHEN subscription_type = 'Unlimited' THEN true
         WHEN subscription_type = 'Premium' AND subscription_end >= now() THEN true
         ELSE false
       END
     FROM public.guilds
     WHERE id = p_guild),
    true
  );
END;
$$;

-- 2. Update populate_event_participants to resolve target guild from event_status first
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
    RAISE EXCEPTION 'event_name, session_id and week_start are required';
  END IF;

  -- 1. Resolve guild directly from event_status for this session (ground truth)
  SELECT guild INTO v_guild
  FROM event_status
  WHERE event_name = p_event_name AND session_id = p_session_id;

  -- 2. Fallback to caller account guild if not found
  IF v_guild IS NULL THEN
    SELECT guild INTO v_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();
  END IF;

  -- 3. Fallback to 'ALPHA' if still null
  IF v_guild IS NULL THEN
    v_guild := 'ALPHA';
  END IF;

  WITH ins AS (
    INSERT INTO event_participants (event_name, week_start, session_id, pseudo, guild, participated, score)
    SELECT p_event_name, p_week_start, p_session_id, gm.pseudo, COALESCE(gm.guild, v_guild), 0, NULL
    FROM guild_members gm
    WHERE COALESCE(gm.guild, 'ALPHA') = COALESCE(v_guild, 'ALPHA')
      AND NOT EXISTS (
        SELECT 1 FROM event_participants ep
        WHERE ep.event_name = p_event_name
          AND ep.session_id = p_session_id
          AND ep.pseudo = gm.pseudo
          AND COALESCE(ep.guild, 'ALPHA') = COALESCE(gm.guild, 'ALPHA')
      )
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM ins;

  RETURN inserted_count;
END;
$$;
