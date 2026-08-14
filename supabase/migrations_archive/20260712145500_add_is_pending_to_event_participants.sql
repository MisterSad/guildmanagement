-- Add is_pending column to event_participants table
ALTER TABLE public.event_participants
  ADD COLUMN IF NOT EXISTS is_pending boolean DEFAULT false;
