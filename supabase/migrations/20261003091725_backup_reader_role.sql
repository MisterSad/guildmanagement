-- 20261003091725_backup_reader_role.sql
--
-- A read-only login role for the nightly backup (.github/workflows/db-backup.yml,
-- docs/BACKUP_RUNBOOK.md). Audit finding INF-01: the project is on the Supabase
-- Free plan, which keeps no backups, and nothing else did.
--
-- Why a dedicated role rather than `postgres`: the connection string lives in a
-- GitHub secret. If it leaks, it should read the data it was meant to back up
-- and nothing more -- not alter the schema, not write a row, not create roles.
--
--   pg_read_all_data   SELECT on every table, view and sequence, in every schema
--                      (public, auth, storage, cron, supabase_migrations).
--   BYPASSRLS          pg_dump runs with row_security = off and aborts on any
--                      table whose policies would hide rows. Without it the dump
--                      fails on the first RLS-enabled table.
--   read-only default  a session opened by this role cannot write even if a
--                      grant is added by mistake later.
--   CONNECTION LIMIT 2 one dump at a time, plus room for a manual check.
--
-- No password is set here: a migration is checked in, a password must not be.
-- The owner sets it once (docs/BACKUP_RUNBOOK.md) and stores the connection
-- string as the BACKUP_DATABASE_URL secret. Until then the role cannot log in.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gm_backup') THEN
    CREATE ROLE gm_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
      BYPASSRLS NOREPLICATION CONNECTION LIMIT 2;
  END IF;
END
$role$;

GRANT pg_read_all_data TO gm_backup;
GRANT CONNECT ON DATABASE postgres TO gm_backup;
ALTER ROLE gm_backup SET default_transaction_read_only = on;

COMMENT ON ROLE gm_backup IS
  'Read-only login for the nightly pg_dump (.github/workflows/db-backup.yml). '
  'Password set by the owner, never in a migration. See docs/BACKUP_RUNBOOK.md.';

DO $check$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'gm_backup';
  IF NOT r.rolcanlogin OR NOT r.rolbypassrls THEN
    RAISE EXCEPTION 'gm_backup must be able to log in and bypass RLS to dump';
  END IF;
  IF r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'gm_backup must hold no administrative attribute';
  END IF;
  IF NOT pg_has_role('gm_backup', 'pg_read_all_data', 'USAGE') THEN
    RAISE EXCEPTION 'gm_backup must inherit pg_read_all_data';
  END IF;
  IF pg_has_role('gm_backup', 'pg_write_all_data', 'USAGE') THEN
    RAISE EXCEPTION 'gm_backup must not be able to write';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
