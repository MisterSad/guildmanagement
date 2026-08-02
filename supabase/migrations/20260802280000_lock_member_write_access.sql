-- Migration A: lock down guild WRITE access to admins only.
-- check_user_guild_write_access previously returned
--   COALESCE(v_guild, 'ALPHA') = p_guild
-- for any non-super_admin (including 'member'), so a player account could
-- INSERT/UPDATE/DELETE on 8 tenant tables via the REST API. The write
-- policies reference this function, so fixing it fixes every table.
-- Super admin can write everywhere (owner-level, as decided).

create or replace function public.check_user_guild_write_access(p_guild text)
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

  -- Super admin may write to every guild.
  if v_role = 'super_admin' then
    return true;
  end if;

  -- Only guild admins may write tenant data. Members go through the portal.
  if v_role <> 'guild_admin' then
    return false;
  end if;

  return coalesce(v_guild, 'ALPHA') = p_guild;
end;
$function$;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
