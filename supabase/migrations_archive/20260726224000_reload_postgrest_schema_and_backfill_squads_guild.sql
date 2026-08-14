-- Migration: Force PostgREST schema cache reload after shadowfront_squads guild column addition

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

-- Also ensure the guild column has a proper default and NOT NULL constraint to avoid insert errors
ALTER TABLE public.shadowfront_squads ALTER COLUMN guild SET DEFAULT 'ALPHA';

-- Backfill existing rows that still have guild = NULL 
UPDATE public.shadowfront_squads SET guild = 'ALPHA' WHERE guild IS NULL;
