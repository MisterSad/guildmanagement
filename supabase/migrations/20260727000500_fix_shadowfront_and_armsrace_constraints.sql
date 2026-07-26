-- Migration: Ensure UNIQUE constraint on shadowfront_squads for tenant upsert matching
-- FIX: Enables idempotent ON CONFLICT (guild, session_id, pseudo) upsert operations in Shadowfront.

DO $$
BEGIN
    -- Add UNIQUE constraint on shadowfront_squads (guild, session_id, pseudo) if not existing
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'shadowfront_squads_guild_session_pseudo_key'
    ) THEN
        -- Remove duplicates if any exist prior to adding constraint
        DELETE FROM public.shadowfront_squads a
        USING public.shadowfront_squads b
        WHERE a.id < b.id
          AND a.guild = b.guild
          AND a.session_id = b.session_id
          AND a.pseudo = b.pseudo;

        ALTER TABLE public.shadowfront_squads
            ADD CONSTRAINT shadowfront_squads_guild_session_pseudo_key UNIQUE (guild, session_id, pseudo);
    END IF;
END $$;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
