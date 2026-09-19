-- 20260920140000_fk_indexes_and_perf_optimizations.sql
-- TICKET-16 [PERF-04]: Database Performance Optimization:
-- 1. Add composite foreign key coverage indexes on high-volume tables (SEV-06)
--    to prevent sequential scans on cascading DELETE/UPDATE from guild_members.
-- 2. Drop redundant indexes on event_status (SEV-11/SEV-12) to minimize write amplification.
-- 3. Notify PostgREST schema cache reload.

-- ============================================================================
-- 1. FOREIGN KEY COVERING INDEXES (SEV-06)
-- ============================================================================

-- event_participants (20k+ rows) references guild_members(guild, pseudo)
CREATE INDEX IF NOT EXISTS idx_event_participants_guild_pseudo 
    ON public.event_participants (guild, pseudo);

-- shadowfront_squads references guild_members(guild, pseudo)
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_guild_pseudo 
    ON public.shadowfront_squads (guild, pseudo);

-- sanctions references guild_members(guild, pseudo)
CREATE INDEX IF NOT EXISTS idx_sanctions_guild_pseudo 
    ON public.sanctions (guild, pseudo);

-- guild_transfers composite foreign keys (source_guild, target_guild, resolved_by)
CREATE INDEX IF NOT EXISTS idx_guild_transfers_fkeys 
    ON public.guild_transfers (source_guild, target_guild, resolved_by);

-- ============================================================================
-- 2. DROP REDUNDANT INDEXES / CONSTRAINTS (SEV-11/SEV-12)
-- ============================================================================

-- event_status_guild_event_name_key is redundant with existing table constraints
ALTER TABLE public.event_status 
    DROP CONSTRAINT IF EXISTS event_status_guild_event_name_key;

DROP INDEX IF EXISTS public.event_status_guild_event_name_key;

-- ============================================================================
-- 3. POSTGREST SCHEMA CACHE RELOAD
-- ============================================================================
NOTIFY pgrst, 'reload schema';
