-- Migration: harden tenant read access with a new function OID.
-- check_user_guild_read_access was replaced via CREATE OR REPLACE (same
-- OID), but PostgREST's prepared plans kept evaluating the old behavior
-- (members could read their own guild's data, leaking guild_config webhooks
-- etc.). A brand-new function name forces a new OID and fresh plans.

create or replace function public.gm_can_read_guild_data(p_guild text)
 returns boolean
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
  v_guild text;
begin
  select role, guild into v_role, v_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null then
    return false;
  end if;

  if v_role = 'super_admin' then
    return true;
  end if;

  -- Only guild admins may read tenant data. Members go through the portal.
  if v_role <> 'guild_admin' then
    return false;
  end if;

  return coalesce(v_guild, 'ALPHA') = p_guild;
end;
$function$;

-- Re-point every SELECT policy of the tenant tables to the new function.
do $$
declare
  tbl text;
  tables text[] := array[
    'guild_members', 'event_participants', 'event_status',
    'shadowfront_squads', 'weekly_scores', 'sanctions', 'banned_players',
    'shadowfront_signups', 'player_name_history', 'guild_config',
    'player_absences'
  ];
begin
  foreach tbl in array tables loop
    execute format('drop policy if exists gm_authenticated_select on public.%I;', tbl);
    execute format('create policy gm_authenticated_select on public.%I for select to authenticated using (public.gm_can_read_guild_data(guild));', tbl);
  end loop;
end $$;

-- player_absences uses its own admin-only policy: point it to the new helper.
drop policy if exists abs_admin_select on public.player_absences;
create policy abs_admin_select on public.player_absences
  for select to authenticated
  using (public.gm_can_read_guild_data(guild));

-- Defensive cleanup: drop any stray permissive SELECT policy that still
-- references the legacy helper (created during debugging) so no table can
-- have more than one SELECT policy.
drop policy if exists gm_auth_select_v2 on public.guild_config;

-- guild_config's legacy ALL policy (gm_guild_config_write) allowed any
-- authenticated user of the same guild to SELECT via check_user_guild_write_access.
-- Restrict it to admins only: SELECT is handled by gm_authenticated_select
-- (admin-only), this policy now covers ALL for admins with an active sub.
drop policy if exists gm_guild_config_write on public.guild_config;
create policy gm_guild_config_write on public.guild_config
  for all to authenticated
  using (public.gm_can_read_guild_data(guild) and public.is_subscription_active(guild))
  with check (public.gm_can_read_guild_data(guild) and public.is_subscription_active(guild));

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
