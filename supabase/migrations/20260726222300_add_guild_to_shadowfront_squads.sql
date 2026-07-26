-- Migration: Add guild column to shadowfront_squads table if missing
ALTER TABLE public.shadowfront_squads ADD COLUMN IF NOT EXISTS guild text DEFAULT 'ALPHA';
