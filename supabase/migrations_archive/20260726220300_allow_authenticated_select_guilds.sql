-- Migration: Allow authenticated users to SELECT from public.guilds
-- Ensures all admins (R4 and R5) can read guild IDs and server numbers for transfer and selection.

ALTER TABLE public.guilds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gm_authenticated_select ON public.guilds;

CREATE POLICY gm_authenticated_select ON public.guilds 
FOR SELECT TO authenticated 
USING (true);
