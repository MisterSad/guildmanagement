-- Migration: player-declared UTC timezone offset (visible to guild admins)
-- Players declare their UTC offset from the Player Portal; guild admins use
-- it to see when the guild has the most players available (coverage view).

alter table public.guild_members
  add column if not exists timezone_offset integer;

-- UTC offsets range -12..+14 hours (standard timezones)
alter table public.guild_members
  drop constraint if exists guild_members_timezone_offset_check;
alter table public.guild_members
  add constraint guild_members_timezone_offset_check
    check (timezone_offset is null or (timezone_offset >= -12 and timezone_offset <= 14));

-- Helper used by the edge function: update the player's own timezone offset.
create or replace function public.gm_update_player_timezone(p_uid text, p_offset integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_offset is null or p_offset < -12 or p_offset > 14 then
    return jsonb_build_object('ok', false, 'error', 'invalid_offset');
  end if;

  update public.guild_members
  set timezone_offset = p_offset
  where uid = p_uid;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'player_not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.gm_update_player_timezone(text, integer) from public, anon, authenticated;
grant execute on function public.gm_update_player_timezone(text, integer) to service_role;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
