-- Migration C: guilds table read access restricted to admins.
-- guilds had two SELECT policies with USING (true), letting any
-- authenticated user (including player accounts) read guild names, server
-- numbers and subscription data. Player accounts need none of it (the
-- portal resolves the guild from their account row). Admins keep read
-- access (needed for transfers and cross-guild views); writes stay
-- super_admin-only.

drop policy if exists "Authenticated users can select guilds" on public.guilds;
drop policy if exists gm_authenticated_select on public.guilds;

create policy gm_authenticated_select on public.guilds
  for select to authenticated
  using (public.gm_can_read_guild_data(id));

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
