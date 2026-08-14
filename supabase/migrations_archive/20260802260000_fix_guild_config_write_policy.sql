-- Migration: restrict guild_config write policy to admins only.
-- The legacy ALL policy used check_user_guild_write_access, which returned
-- true for any authenticated member of the guild, granting SELECT access to
-- guild_config (Discord webhooks, templates, coefficients) through the
-- permissive ALL policy. Now admin-only, gated by subscription for writes.
-- (SELECT access itself is already admin-only via gm_authenticated_select.)

drop policy if exists gm_guild_config_write on public.guild_config;
create policy gm_guild_config_write on public.guild_config
  for all to authenticated
  using (public.gm_can_read_guild_data(guild) and public.is_subscription_active(guild))
  with check (public.gm_can_read_guild_data(guild) and public.is_subscription_active(guild));

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
