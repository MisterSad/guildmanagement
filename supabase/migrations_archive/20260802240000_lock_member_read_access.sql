-- Migration: lock down member read access to guild data.
-- Player accounts (role 'member') never need direct table access: the
-- Player Portal reads and writes exclusively through the member-portal
-- edge function (service_role). Previously check_user_guild_read_access
-- granted members read access to their whole guild (members list with UIDs,
-- sanctions, event history, Discord webhooks in guild_config, ...).
-- Members now get NO read access on tenant tables; only admins do.

create or replace function public.check_user_guild_read_access(p_guild text)
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

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
