-- Add server_number column to public.guilds
ALTER TABLE public.guilds
  ADD COLUMN IF NOT EXISTS server_number text;
