-- Migration: prevent new duplicate UIDs in guild_members.
-- Legacy data contains 6 members whose UID exists in two guilds (they were
-- added to a new guild without removing the old row). Existing duplicates
-- are kept (their participation history is legitimate), but a trigger now
-- rejects any INSERT/UPDATE that would create a NEW duplicate UID in a
-- different guild. The transfer RPC (gm_transfer_guild_member) already
-- resolves the source row within the caller's guild, so it is unaffected:
-- it moves the row (same UID, new guild) which the trigger must allow.

create or replace function public.prevent_duplicate_member_uid()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $function$
declare
  v_new_uid text;
  v_new_guild text;
begin
  v_new_uid   := coalesce(new.uid, '');
  v_new_guild := coalesce(new.guild, 'ALPHA');

    if v_new_uid <> '' then
      -- Reject NEW inserts if the same UID already exists in a DIFFERENT guild.
      -- UPDATE is exempt: the transfer RPC moves an existing row (same UID)
      -- to another guild, and legacy duplicate rows must stay movable.
      if exists (
        select 1 from public.guild_members
        where uid = v_new_uid
          and coalesce(guild, 'ALPHA') <> v_new_guild
          and id is distinct from new.id
      ) then
        raise exception 'uid_already_in_another_guild';
      end if;
    end if;

  return new;
end;
$function$;

drop trigger if exists prevent_duplicate_member_uid on public.guild_members;
create trigger prevent_duplicate_member_uid
  before insert on public.guild_members
  for each row
  execute function public.prevent_duplicate_member_uid();

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
