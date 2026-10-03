-- 20261003170654_reconcile_schema_objects.sql
--
-- Short-term plan, phase 4b (audit DB-01, DB-04, BE-B-05). Production and the
-- repository had drifted apart in both directions:
--
--   * declared by 20260812000001/000004 but never built in production:
--     the index on accounts.auth_user_id (every RLS helper filters on it:
--     11.9 M sequential scans of `accounts` measured by the audit), the index
--     on guild_members.uid, handle_updated_at() and its triggers, and the
--     foreign keys from the tag-carrying tables to guilds(id);
--   * built in production but created by no migration: 19 indexes and three
--     UNIQUE constraints under other names, one of which
--     (shadowfront_squads (guild, session_id, pseudo)) the squad upserts rely on.
--
-- Everything here is idempotent: production only gains what it lacked, and a
-- replay from an empty database ends in the same state.

-- ── 1. Indexes production was missing ─────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_accounts_auth_user_id ON public.accounts (auth_user_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_uid     ON public.guild_members (uid);
-- The (guild, pseudo) foreign key to guild_members had no covering index: every
-- roster delete or rename scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_event_daily_scores_guild_pseudo ON public.event_daily_scores (guild, pseudo);

-- ── 2. Indexes only production had, now versioned (definitions read live) ─────

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_uid ON public.accounts USING btree (uid) WHERE (uid IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS guild_config_join_code_hash_unique ON public.guild_config USING btree (value) WHERE ((key = 'join_code_hash'::text) AND (value IS NOT NULL) AND (value <> ''::text));
CREATE INDEX IF NOT EXISTS idx_audit_logs_service_level ON public.system_audit_logs USING btree (service, level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_participants_guild_event ON public.event_participants USING btree (guild, event_name);
CREATE INDEX IF NOT EXISTS idx_event_participants_guild_session ON public.event_participants USING btree (guild, session_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_pseudo ON public.event_participants USING btree (pseudo);
CREATE INDEX IF NOT EXISTS idx_event_status_guild ON public.event_status USING btree (guild);
CREATE INDEX IF NOT EXISTS idx_event_status_guild_active ON public.event_status USING btree (guild, is_active) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_event_status_guild_session ON public.event_status USING btree (guild, session_id);
CREATE INDEX IF NOT EXISTS idx_guild_config_guild ON public.guild_config USING btree (guild);
CREATE INDEX IF NOT EXISTS idx_player_name_history_uid ON public.player_name_history USING btree (uid);
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_week_start ON public.shadowfront_signups USING btree (week_start);
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_pseudo ON public.shadowfront_squads USING btree (pseudo);
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_session ON public.shadowfront_squads USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_weekly_scores_guild ON public.weekly_scores USING btree (guild);
CREATE INDEX IF NOT EXISTS idx_weekly_scores_guild_week ON public.weekly_scores USING btree (guild, week_start);
CREATE INDEX IF NOT EXISTS idx_weekly_scores_pseudo ON public.weekly_scores USING btree (pseudo);
CREATE INDEX IF NOT EXISTS player_absences_guild_idx ON public.player_absences USING btree (guild);
CREATE INDEX IF NOT EXISTS player_absences_uid_idx ON public.player_absences USING btree (uid);

-- ── 3. UNIQUE constraints: production's names, and the one the repo lacked ─────

DO $uniq$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('shadowfront_squads',  'shadowfront_squads_guild_week_pseudo_key',  'shadowfront_squads_guild_week_start_pseudo_key'),
      ('shadowfront_signups', 'shadowfront_signups_guild_week_pseudo_key', 'shadowfront_signups_guild_week_start_pseudo_key'),
      ('weekly_scores',       'weekly_scores_guild_week_pseudo_key',       'weekly_scores_guild_week_start_pseudo_key')
  ) v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || r.tbl)::regclass AND conname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || r.tbl)::regclass AND conname = r.new_name) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.shadowfront_squads'::regclass
                 AND conname = 'shadowfront_squads_guild_session_pseudo_key') THEN
    ALTER TABLE public.shadowfront_squads
      ADD CONSTRAINT shadowfront_squads_guild_session_pseudo_key UNIQUE (guild, session_id, pseudo);
  END IF;
END
$uniq$;

-- ── 4. updated_at maintained by the database, not by each caller ──────────────
-- gm_cleanup_stale_reminder_locks ages the `sent_%` locks of guild_config by
-- this column. Every caller already writes now(); the trigger makes it the
-- server's clock and stops a forgotten caller from freezing it.

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guild_config_updated_at ON public.guild_config;
CREATE TRIGGER trg_guild_config_updated_at
    BEFORE UPDATE ON public.guild_config
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_player_absences_updated_at ON public.player_absences;
CREATE TRIGGER trg_player_absences_updated_at
    BEFORE UPDATE ON public.player_absences
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_event_status_updated_at ON public.event_status;
CREATE TRIGGER trg_event_status_updated_at
    BEFORE UPDATE ON public.event_status
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ── 5. Foreign keys to guilds(id) (ADR-022) ───────────────────────────────────
-- ON UPDATE CASCADE: a rename moves the rows. ON DELETE NO ACTION: deleting a
-- guild stays explicit, through gm_purge_guild_data, which already clears each
-- of these tables before the guild row. A direct DELETE on guilds that would
-- leave rows behind (DB-13) is now refused instead.
-- DEFERRABLE INITIALLY IMMEDIATE: gm_rename_guild defers them for the length of
-- the rename only.
--
-- Not system_audit_logs: a log line must never fail because of the tag it
-- carries (2 lines hold guild = '' today). It stays in the explicit lists of
-- gm_rename_guild and gm_purge_guild_data.
-- 0 orphans measured on production on 2026-10-03; ADD CONSTRAINT validates
-- every row and would abort this migration on the first one.

DO $fk$
DECLARE
  r record;
  v_old record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('accounts',           'guild'),
      ('account_link_codes', 'guild'),
      ('banned_players',     'guild'),
      ('event_status',       'guild'),
      ('guild_config',       'guild'),
      ('guild_members',      'guild'),
      ('player_absences',    'guild'),
      ('war_opponents',      'guild_ref')
  ) v(tbl, col) LOOP
    -- The base migrations of the repository declared some of these keys ON
    -- DELETE CASCADE, under other names. Production never had them; an empty
    -- replay does. Any key on the column that is not exactly the one below goes.
    FOR v_old IN
      SELECT k.conname FROM pg_constraint k
      WHERE k.conrelid = ('public.' || r.tbl)::regclass AND k.contype = 'f'
        AND k.confrelid = 'public.guilds'::regclass
        AND k.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = ('public.' || r.tbl)::regclass AND attname = r.col)]
        AND NOT (k.conname = r.tbl || '_' || r.col || '_fkey' AND k.confupdtype = 'c' AND k.confdeltype = 'a'
                 AND k.condeferrable AND NOT k.condeferred)
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, v_old.conname);
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = ('public.' || r.tbl)::regclass AND c.contype = 'f'
        AND c.confrelid = 'public.guilds'::regclass
        AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = ('public.' || r.tbl)::regclass AND attname = r.col)]
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.guilds(id) '
        'ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE',
        r.tbl, r.tbl || '_' || r.col || '_fkey', r.col);
    END IF;
  END LOOP;
END
$fk$;

-- ── 6. Dead code ──────────────────────────────────────────────────────────────
-- gm_session_id_base: nothing calls either signature (no function, policy,
-- cron job or client). The app derives the base in src/core/config/events.ts.

DROP FUNCTION IF EXISTS public.gm_session_id_base(text);
DROP FUNCTION IF EXISTS public.gm_session_id_base(text, date);

-- ── 7. Assert the end state ───────────────────────────────────────────────────

DO $check$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(n, ', ') INTO v_missing FROM unnest(ARRAY[
    'idx_accounts_auth_user_id', 'idx_guild_members_uid', 'idx_event_daily_scores_guild_pseudo',
    'idx_accounts_uid', 'guild_config_join_code_hash_unique',
    'shadowfront_squads_guild_session_pseudo_key', 'shadowfront_squads_guild_week_start_pseudo_key',
    'shadowfront_signups_guild_week_start_pseudo_key', 'weekly_scores_guild_week_start_pseudo_key'
  ]) n WHERE to_regclass('public.' || n) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'reconcile: missing index %', v_missing;
  END IF;

  IF (SELECT count(*) FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'public.guilds'::regclass
        AND c.conname IN ('accounts_guild_fkey', 'account_link_codes_guild_fkey', 'banned_players_guild_fkey',
                          'event_status_guild_fkey', 'guild_config_guild_fkey', 'guild_members_guild_fkey',
                          'player_absences_guild_fkey', 'war_opponents_guild_ref_fkey')
        AND c.confupdtype = 'c' AND c.confdeltype = 'a' AND c.condeferrable AND NOT c.condeferred) <> 8 THEN
    RAISE EXCEPTION 'reconcile: a foreign key to guilds is missing or has the wrong actions';
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('trg_guild_config_updated_at', 'trg_player_absences_updated_at', 'trg_event_status_updated_at')) <> 3 THEN
    RAISE EXCEPTION 'reconcile: an updated_at trigger is missing';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gm_session_id_base' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'reconcile: gm_session_id_base still exists';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
