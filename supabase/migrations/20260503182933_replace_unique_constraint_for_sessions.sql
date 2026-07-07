-- Supprime l'ancienne contrainte d'unicité (event_name, week_start, pseudo)
-- qui empêche d'avoir plusieurs sessions du même événement dans la même semaine.
ALTER TABLE event_participants 
  DROP CONSTRAINT IF EXISTS event_participants_event_name_week_start_pseudo_key;

-- Index unique pour les rows avec session_id (sessions normales : 1 row par session/joueur)
CREATE UNIQUE INDEX IF NOT EXISTS event_participants_session_unique
  ON event_participants (event_name, session_id, pseudo)
  WHERE session_id IS NOT NULL;

-- Index unique pour les rows sans session (Glory, données legacy : 1 row par semaine/joueur)
CREATE UNIQUE INDEX IF NOT EXISTS event_participants_no_session_unique
  ON event_participants (event_name, week_start, pseudo)
  WHERE session_id IS NULL;

NOTIFY pgrst, 'reload schema';;
