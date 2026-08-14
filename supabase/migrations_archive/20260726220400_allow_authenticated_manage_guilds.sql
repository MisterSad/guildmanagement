-- Migration: Allow authenticated users to INSERT, UPDATE, DELETE on public.guilds
-- Ensures Super Admin (and authenticated admins) can create, update server numbers, and manage subscriptions on guilds.

ALTER TABLE public.guilds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gm_authenticated_select ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_insert ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_update ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_delete ON public.guilds;

CREATE POLICY gm_authenticated_select ON public.guilds FOR SELECT TO authenticated USING (true);
CREATE POLICY gm_authenticated_insert ON public.guilds FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY gm_authenticated_update ON public.guilds FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY gm_authenticated_delete ON public.guilds FOR DELETE TO authenticated USING (true);
