-- 1. Nettoyer les lignes orphelines avant d'ajouter les contraintes FK
DELETE FROM event_participants 
WHERE pseudo NOT IN (SELECT pseudo FROM guild_members);

DELETE FROM weekly_scores 
WHERE pseudo NOT IN (SELECT pseudo FROM guild_members);

DELETE FROM shadowfront_squads 
WHERE pseudo NOT IN (SELECT pseudo FROM guild_members);

-- 2. Ajouter session_id (text) à event_participants
-- NULL = legacy/Glory (pas de session, identifie par week_start)
ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS session_id text;

-- 3. Ajouter session_id et stage à event_status
-- session_id = ID de la session active courante (NULL si inactif)
-- stage = "A" / "B" pour Arms Race (NULL sinon)
ALTER TABLE event_status ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE event_status ADD COLUMN IF NOT EXISTS stage text;

-- 4. Index pour les performances
CREATE INDEX IF NOT EXISTS idx_event_participants_session 
  ON event_participants(event_name, session_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_pseudo 
  ON event_participants(pseudo);
CREATE INDEX IF NOT EXISTS idx_event_participants_week 
  ON event_participants(week_start);
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_pseudo 
  ON shadowfront_squads(pseudo);
CREATE INDEX IF NOT EXISTS idx_weekly_scores_pseudo 
  ON weekly_scores(pseudo);

-- 5. Ajouter les FK avec ON DELETE / UPDATE CASCADE
-- pseudo dans guild_members est UNIQUE → peut être référencé
ALTER TABLE event_participants 
  ADD CONSTRAINT event_participants_pseudo_fkey 
  FOREIGN KEY (pseudo) REFERENCES guild_members(pseudo) 
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE shadowfront_squads 
  ADD CONSTRAINT shadowfront_squads_pseudo_fkey 
  FOREIGN KEY (pseudo) REFERENCES guild_members(pseudo) 
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE weekly_scores 
  ADD CONSTRAINT weekly_scores_pseudo_fkey 
  FOREIGN KEY (pseudo) REFERENCES guild_members(pseudo) 
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Recréer la FK existante de sanctions avec CASCADE
ALTER TABLE sanctions DROP CONSTRAINT IF EXISTS sanctions_pseudo_fkey;
ALTER TABLE sanctions 
  ADD CONSTRAINT sanctions_pseudo_fkey 
  FOREIGN KEY (pseudo) REFERENCES guild_members(pseudo) 
  ON DELETE CASCADE ON UPDATE CASCADE;;
