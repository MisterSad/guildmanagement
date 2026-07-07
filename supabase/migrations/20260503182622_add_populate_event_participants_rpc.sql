-- Fonction RPC : importe tous les guild_members dans event_participants
-- pour la session indiquée. Idempotent (skip ce qui existe déjà).
-- Renvoie le nombre de lignes effectivement insérées.
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
BEGIN
  IF p_event_name IS NULL OR p_session_id IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'event_name, session_id et week_start sont requis';
  END IF;

  WITH ins AS (
    INSERT INTO event_participants (event_name, week_start, session_id, pseudo, participated, score)
    SELECT p_event_name, p_week_start, p_session_id, gm.pseudo, 0, NULL
    FROM guild_members gm
    WHERE NOT EXISTS (
      SELECT 1 FROM event_participants ep
      WHERE ep.event_name = p_event_name
        AND ep.session_id = p_session_id
        AND ep.pseudo = gm.pseudo
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted_count FROM ins;

  RETURN inserted_count;
END;
$$;

-- Permettre à anon et authenticated d'appeler la fonction
GRANT EXECUTE ON FUNCTION public.populate_event_participants(text, text, date) TO anon, authenticated;

-- Force le rechargement du schema cache PostgREST pour exposer la fonction
NOTIFY pgrst, 'reload schema';;
