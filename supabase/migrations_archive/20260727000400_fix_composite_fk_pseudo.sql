-- Migration: Fix composite FK on pseudo for multi-tenant correctness
-- ISSUE (C5): Tables event_participants, weekly_scores, sanctions, shadowfront_squads
-- have FK: FOREIGN KEY (pseudo) REFERENCES guild_members(pseudo)
-- This forces guild_members.pseudo to be globally unique across ALL guilds,
-- preventing "John" in ALPHA and "John" in OMEGA from coexisting.
--
-- FIX: Change to composite FK (guild, pseudo) REFERENCES guild_members(guild, pseudo)
-- This is non-destructive: existing data is valid under both constraints.
-- Requires a UNIQUE index on (guild, pseudo) in guild_members first.

-- Step 1: Add UNIQUE index on (guild, pseudo) in guild_members
-- This is the referenced side of the new composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS guild_members_guild_pseudo_key
    ON public.guild_members(guild, pseudo);

-- Step 2: Drop the old single-column FK constraints
ALTER TABLE public.event_participants
    DROP CONSTRAINT IF EXISTS event_participants_pseudo_fkey;

ALTER TABLE public.shadowfront_squads
    DROP CONSTRAINT IF EXISTS shadowfront_squads_pseudo_fkey;

ALTER TABLE public.weekly_scores
    DROP CONSTRAINT IF EXISTS weekly_scores_pseudo_fkey;

ALTER TABLE public.sanctions
    DROP CONSTRAINT IF EXISTS sanctions_pseudo_fkey;

-- Step 3: Recreate FKs as composite (guild, pseudo) with CASCADE
ALTER TABLE public.event_participants
    ADD CONSTRAINT event_participants_guild_pseudo_fkey
    FOREIGN KEY (guild, pseudo)
    REFERENCES public.guild_members(guild, pseudo)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.shadowfront_squads
    ADD CONSTRAINT shadowfront_squads_guild_pseudo_fkey
    FOREIGN KEY (guild, pseudo)
    REFERENCES public.guild_members(guild, pseudo)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.weekly_scores
    ADD CONSTRAINT weekly_scores_guild_pseudo_fkey
    FOREIGN KEY (guild, pseudo)
    REFERENCES public.guild_members(guild, pseudo)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public.sanctions
    ADD CONSTRAINT sanctions_guild_pseudo_fkey
    FOREIGN KEY (guild, pseudo)
    REFERENCES public.guild_members(guild, pseudo)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Note: The old single-column UNIQUE constraint on guild_members.pseudo (if present)
-- is intentionally kept. It prevents duplicate pseudos within legacy usage patterns,
-- but will be superseded by the composite unique index for FK purposes.
-- If you want to allow same pseudo across guilds (full multi-tenant), you can
-- additionally drop the old UNIQUE(pseudo) constraint:
--   ALTER TABLE public.guild_members DROP CONSTRAINT IF EXISTS guild_members_pseudo_key;
-- This is left as a manual step since it requires verifying no current cross-guild duplicates.
