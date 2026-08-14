-- Add late, excused and appointed columns to event_participants table
ALTER TABLE public.event_participants
  ADD COLUMN IF NOT EXISTS late boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS excused boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS appointed boolean DEFAULT false;

-- Add is_commander column to shadowfront_squads table
ALTER TABLE public.shadowfront_squads
  ADD COLUMN IF NOT EXISTS is_commander boolean DEFAULT false;
