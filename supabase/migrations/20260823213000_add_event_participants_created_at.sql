-- 20260823213000_add_event_participants_created_at.sql
-- Workstream: live schema reconciliation for event_participants
--
-- Root cause (2026-08-23 incident): the canonical master DDL (20260812000001)
-- defines event_participants WITH a created_at column and a non-partial
-- UNIQUE (guild, event_name, session_id, pseudo) constraint, but the live
-- table was created by earlier migrations WITHOUT either. The master DDL uses
-- CREATE TABLE IF NOT EXISTS, which is a no-op on the live database, so
-- neither artifact materialized there. Runtime writers referencing them
-- (notably gm_upsert_player_glory and every RPC using plain
-- ON CONFLICT (guild, event_name, session_id, pseudo)) failed on live with
-- "column created_at ... does not exist" then
-- "no unique or exclusion constraint matching the ON CONFLICT specification",
-- while a fresh canonical replay would have succeeded.
--
-- This migration converges the live schema to the canonical DDL. Fresh
-- replays are unaffected (both artifacts already exist there).

-- 1. Missing column
ALTER TABLE public.event_participants ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- 2. Missing non-partial unique constraint (arbiter for plain ON CONFLICT forms)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'event_participants_guild_event_session_pseudo_key'
          AND conrelid = 'public.event_participants'::regclass
    ) THEN
        ALTER TABLE public.event_participants
        ADD CONSTRAINT event_participants_guild_event_session_pseudo_key
        UNIQUE (guild, event_name, session_id, pseudo);
    END IF;
END $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_guild_event_session_pseudo_key;
-- ALTER TABLE public.event_participants DROP COLUMN IF EXISTS created_at;
*/
