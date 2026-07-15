-- Remove strongest_fleet column from guild_members table
ALTER TABLE public.guild_members DROP COLUMN IF EXISTS strongest_fleet;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
