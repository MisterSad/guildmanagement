-- Migration B: remove the obsolete permissive read helper.
-- check_user_guild_read_access is no longer referenced by any policy
-- (all tenant SELECT policies now use gm_can_read_guild_data). Dropping it
-- prevents accidental reuse of the old member-permissive logic.
-- Guard: abort if any policy still references it.

do $$
declare
  v_refs integer;
begin
  select count(*) into v_refs
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where pg_get_expr(p.polqual, p.polrelid) ilike '%check_user_guild_read_access%'
     or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%check_user_guild_read_access%';

  if v_refs > 0 then
    raise exception 'check_user_guild_read_access is still referenced by % policy/policies', v_refs;
  end if;
end $$;

drop function if exists public.check_user_guild_read_access(text);

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
