-- 20261003174320_reconcile_replay_to_production.sql
--
-- Short-term plan, phase 5 (audit DB-01, DB-03). The migration chain now
-- replays on an empty PostgreSQL 17 (scripts/replay-migrations.sh), and
-- supabase/replay/schema-fingerprint.sql compares the result with production.
-- On 2026-10-03 the first full replay differed from production in 84 places.
--
-- Most mattered little (index and constraint names). Two would have been
-- incidents on a restore built from the repository:
--   * `authenticated` got INSERT, UPDATE and DELETE on public.accounts, and
--     SELECT on every column, credentials included: finding C0 again.
--     Production grants it SELECT on 8 columns and nothing else.
--   * three authorisation helpers were executable by PUBLIC and anon.
--
-- Every statement below is conditional. On production nothing changes except
-- one deliberate improvement (accounts.created_at gets the default now(); 27
-- rows were created without a date). On a replay, the database ends equal to
-- production, and the CI job proves it against tests/fixtures/schema_fingerprint.txt.

-- ── 1. public.accounts: production's grants exactly (C0) ─────────────────────

REVOKE ALL ON TABLE public.accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, role, guild, uid, status, server_number, auth_user_id, created_at)
  ON public.accounts TO authenticated;
GRANT ALL ON TABLE public.accounts TO service_role;

ALTER TABLE public.accounts ALTER COLUMN created_at SET DEFAULT now();

-- ── 2. Authorisation helpers: not executable without a session ───────────────

REVOKE ALL ON FUNCTION public.check_user_guild_write_access(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gm_can_read_guild_data(text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gm_can_admin_see_absences(text)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_user_guild_write_access(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gm_can_read_guild_data(text)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gm_can_admin_see_absences(text)     TO authenticated, service_role;

-- A text-typed overload only the repository ever created.
DROP FUNCTION IF EXISTS public.gm_upsert_player_glory(text, text, text, bigint);

-- ── 3. Columns ──────────────────────────────────────────────────────────────

-- Only the repository's base migration added it; production dropped it.
ALTER TABLE public.guilds DROP COLUMN IF EXISTS name;

DO $ident$
DECLARE
  v_next bigint;
BEGIN
  IF (SELECT is_identity FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'banned_players' AND column_name = 'id') = 'NO' THEN
    SELECT coalesce(max(id), 0) + 1 INTO v_next FROM public.banned_players;
    ALTER TABLE public.banned_players ALTER COLUMN id DROP DEFAULT;
    DROP SEQUENCE IF EXISTS public.banned_players_id_seq;
    EXECUTE format('ALTER TABLE public.banned_players ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)', v_next);
  END IF;
END
$ident$;

-- ── 4. event_status: keyed on (guild, event_name), as production ─────────────

DO $es$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.event_status'::regclass AND contype = 'p') <> 'PRIMARY KEY (guild, event_name)' THEN
    ALTER TABLE public.event_status DROP CONSTRAINT event_status_pkey;
    ALTER TABLE public.event_status DROP CONSTRAINT IF EXISTS event_status_guild_event_name_session_key;
    DROP INDEX IF EXISTS public.event_status_guild_event_key;
    ALTER TABLE public.event_status ADD CONSTRAINT event_status_pkey PRIMARY KEY (guild, event_name);
  END IF;
END
$es$;

-- ── 5. Foreign keys: production's names, no duplicate guild keys ─────────────

DO $fk$
DECLARE
  r record;
BEGIN
  -- The member keys under production's names.
  FOR r IN SELECT * FROM (VALUES
      ('event_participants',  'fk_event_participants_member',  'event_participants_guild_pseudo_fkey'),
      ('sanctions',           'fk_sanctions_member',           'sanctions_guild_pseudo_fkey'),
      ('shadowfront_signups', 'fk_shadowfront_signups_member', 'shadowfront_signups_pseudo_fkey'),
      ('shadowfront_squads',  'fk_shadowfront_squads_member',  'shadowfront_squads_guild_pseudo_fkey'),
      ('weekly_scores',       'fk_weekly_scores_member',       'weekly_scores_guild_pseudo_fkey')
  ) v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || r.tbl)::regclass AND conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || r.tbl)::regclass AND conname = r.new_name) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;

  -- These tables reach guilds through guild_members(guild, pseudo). A second,
  -- direct ON DELETE CASCADE key to guilds exists only in the repository's
  -- base migration, and would bypass gm_purge_guild_data.
  FOR r IN SELECT * FROM (VALUES
      ('event_participants',  'event_participants_guild_fkey'),
      ('sanctions',           'sanctions_guild_fkey'),
      ('shadowfront_signups', 'shadowfront_signups_guild_fkey'),
      ('shadowfront_squads',  'shadowfront_squads_guild_fkey'),
      ('weekly_scores',       'weekly_scores_guild_fkey'),
      ('player_name_history', 'player_name_history_guild_fkey')
  ) v(tbl, con) LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', r.tbl, r.con);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_transfers_resolved_by_fkey') THEN
    ALTER TABLE public.guild_transfers
      ADD CONSTRAINT guild_transfers_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END
$fk$;

-- ── 6. CHECK constraints production has ──────────────────────────────────────

DO $chk$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('guild_members',       'guild_members_role_check',               'CHECK (role = ANY (ARRAY[''R1''::text, ''R2''::text, ''R3''::text, ''R4''::text, ''R5''::text]))'),
      ('player_absences',     'player_absences_check',                  'CHECK (end_date >= start_date)'),
      ('player_absences',     'player_absences_kind_check',             'CHECK (kind = ANY (ARRAY[''full''::text, ''reduced''::text]))'),
      ('shadowfront_signups', 'shadowfront_signups_availability_check', 'CHECK (availability = ANY (ARRAY[''squad1''::text, ''squad2''::text, ''both''::text, ''none''::text]))'),
      ('shadowfront_squads',  'shadowfront_squads_role_check',          'CHECK (role = ANY (ARRAY[''participant''::text, ''reserve''::text]))'),
      ('shadowfront_squads',  'shadowfront_squads_squad_check',         'CHECK (squad = ANY (ARRAY[''squad1''::text, ''squad2''::text]))'),
      ('system_audit_logs',   'system_audit_logs_level_check',          'CHECK (level = ANY (ARRAY[''DEBUG''::text, ''INFO''::text, ''WARN''::text, ''ERROR''::text, ''FATAL''::text]))')
  ) v(tbl, con, def) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || r.tbl)::regclass AND conname = r.con) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', r.tbl, r.con, r.def);
    END IF;
  END LOOP;
END
$chk$;

-- ── 7. Trigger: production's name and event ──────────────────────────────────
-- BEFORE INSERT only: a transfer UPDATEs an existing row, and legacy duplicate
-- rows must stay movable (see the function's own comment).

DROP TRIGGER IF EXISTS trg_prevent_duplicate_member_uid ON public.guild_members;
DO $trg$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.guild_members'::regclass
                 AND tgname = 'prevent_duplicate_member_uid') THEN
    CREATE TRIGGER prevent_duplicate_member_uid BEFORE INSERT ON public.guild_members
      FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_member_uid();
  END IF;
END
$trg$;

-- ── 8. Indexes: production's set ─────────────────────────────────────────────

DROP INDEX IF EXISTS public.idx_player_absences_guild_uid;
DROP INDEX IF EXISTS public.idx_shadowfront_squads_week;
DROP INDEX IF EXISTS public.idx_system_audit_logs_correlation;
DROP INDEX IF EXISTS public.idx_system_audit_logs_guild_created;
DROP INDEX IF EXISTS public.idx_system_audit_logs_level_created;

CREATE INDEX IF NOT EXISTS idx_event_participants_guild ON public.event_participants USING btree (guild);
CREATE INDEX IF NOT EXISTS idx_sanctions_guild ON public.sanctions USING btree (guild);
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_pseudo ON public.shadowfront_signups USING btree (pseudo);
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_guild ON public.shadowfront_squads USING btree (guild);

DO $idx$
BEGIN
  IF (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_event_participants_session')
     <> 'CREATE INDEX idx_event_participants_session ON public.event_participants USING btree (event_name, session_id)' THEN
    DROP INDEX public.idx_event_participants_session;
    CREATE INDEX idx_event_participants_session ON public.event_participants USING btree (event_name, session_id);
  END IF;
  IF (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_event_participants_week')
     <> 'CREATE INDEX idx_event_participants_week ON public.event_participants USING btree (week_start)' THEN
    DROP INDEX public.idx_event_participants_week;
    CREATE INDEX idx_event_participants_week ON public.event_participants USING btree (week_start);
  END IF;
END
$idx$;

-- ── 9. Assert the end state ──────────────────────────────────────────────────

DO $check$
BEGIN
  IF has_table_privilege('authenticated', 'public.accounts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.accounts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.accounts', 'DELETE')
     OR has_column_privilege('authenticated', 'public.accounts', 'password_hash', 'SELECT')
     OR has_column_privilege('authenticated', 'public.accounts', 'password_enc', 'SELECT')
     OR has_column_privilege('authenticated', 'public.accounts', 'gotrue_secret_enc', 'SELECT')
     OR has_table_privilege('anon', 'public.accounts', 'SELECT') THEN
    RAISE EXCEPTION 'reconcile: public.accounts is wider than production (C0)';
  END IF;
  IF has_function_privilege('anon', 'public.gm_can_read_guild_data(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_user_guild_write_access(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.gm_can_admin_see_absences(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reconcile: an authorisation helper is executable by anon';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.event_status'::regclass AND contype = 'p') <> 'PRIMARY KEY (guild, event_name)' THEN
    RAISE EXCEPTION 'reconcile: event_status is not keyed on (guild, event_name)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE confrelid = 'public.guilds'::regclass AND confdeltype = 'c'
                AND conrelid IN ('public.event_participants'::regclass, 'public.sanctions'::regclass,
                                 'public.shadowfront_signups'::regclass, 'public.shadowfront_squads'::regclass,
                                 'public.weekly_scores'::regclass)) THEN
    RAISE EXCEPTION 'reconcile: a direct cascading key to guilds bypasses gm_purge_guild_data';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
