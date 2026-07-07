ALTER TABLE shadowfront_squads ADD COLUMN IF NOT EXISTS session_id text;
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_session 
  ON shadowfront_squads(session_id);;
