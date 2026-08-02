-- Migration: fix player_absences admin-only SELECT policy.
-- The previous policy queried public.accounts directly from RLS, which runs
-- with the caller's privileges (authenticated) — accounts is revoked for
-- everyone, so both admins AND players got "permission denied".
-- Replace with a SECURITY DEFINER helper that checks the admin role only.

create or replace function public.gm_can_admin_see_absences(p_guild text)
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

  -- Only guild admins (not plain members) may read absence declarations.
  if v_role <> 'guild_admin' then
    return false;
  end if;

  return coalesce(v_guild, 'ALPHA') = p_guild;
end;
$function$;

revoke all on function public.gm_can_admin_see_absences(text) from public, anon, authenticated;
grant execute on function public.gm_can_admin_see_absences(text) to authenticated;

drop policy if exists abs_admin_select on public.player_absences;
create policy abs_admin_select on public.player_absences
  for select to authenticated
  using (public.gm_can_admin_see_absences(guild));

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
