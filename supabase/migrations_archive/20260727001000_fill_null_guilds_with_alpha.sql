-- Migration: Fill all NULL guild entries with 'ALPHA' for 100% clean single-filter queries
DO $$
BEGIN
    UPDATE public.guild_members SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.event_participants SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.event_status SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.shadowfront_squads SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.weekly_scores SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.sanctions SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.banned_players SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.shadowfront_signups SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.player_name_history SET guild = 'ALPHA' WHERE guild IS NULL;
    UPDATE public.guild_config SET guild = 'ALPHA' WHERE guild IS NULL;
END $$;

-- Set default 'ALPHA' for future inserts
ALTER TABLE public.guild_members ALTER COLUMN guild SET DEFAULT 'ALPHA';
ALTER TABLE public.event_participants ALTER COLUMN guild SET DEFAULT 'ALPHA';
ALTER TABLE public.event_status ALTER COLUMN guild SET DEFAULT 'ALPHA';
ALTER TABLE public.shadowfront_squads ALTER COLUMN guild SET DEFAULT 'ALPHA';
ALTER TABLE public.weekly_scores ALTER COLUMN guild SET DEFAULT 'ALPHA';
ALTER TABLE public.sanctions ALTER COLUMN guild SET DEFAULT 'ALPHA';
ALTER TABLE public.banned_players ALTER COLUMN guild SET DEFAULT 'ALPHA';

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
