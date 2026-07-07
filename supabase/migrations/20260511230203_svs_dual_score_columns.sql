ALTER TABLE public.event_participants
  ADD COLUMN IF NOT EXISTS score_prep integer,
  ADD COLUMN IF NOT EXISTS score_pvp  integer;;
