-- Migration: Replace global UNIQUE constraint on event_participants with partial unique indexes
-- Fixes Arms Race and Shadowfront session creation & participant insertion errors.

DO $$
BEGIN
    -- 1. Drop restrictive table constraint that blocked session events when week_start repeated
    ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_guild_event_week_pseudo_key;
    ALTER TABLE public.event_participants DROP CONSTRAINT IF EXISTS event_participants_guild_event_session_pseudo_key;

    -- 2. Create partial unique index for non-session events (Glory) where session_id IS NULL
    DROP INDEX IF EXISTS public.event_participants_no_session_unique;
    CREATE UNIQUE INDEX event_participants_no_session_unique
        ON public.event_participants (guild, event_name, week_start, pseudo)
        WHERE session_id IS NULL;

    -- 3. Create partial unique index for session events (Arms Race, SF, SvS, GvG, DTR) where session_id IS NOT NULL
    DROP INDEX IF EXISTS public.event_participants_session_unique;
    CREATE UNIQUE INDEX event_participants_session_unique
        ON public.event_participants (guild, event_name, session_id, pseudo)
        WHERE session_id IS NOT NULL;
END $$;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
