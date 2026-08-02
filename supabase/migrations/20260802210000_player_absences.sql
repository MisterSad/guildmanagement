-- Migration: player-declared absence periods (visible to guild admins)
-- Players declare absences or reduced activity from the Player Portal;
-- guild admins see them in their tenant.

-- 1. Table
create table if not exists public.player_absences (
  id          uuid primary key default gen_random_uuid(),
  guild       text not null,
  pseudo      text not null,
  uid         text not null,
  start_date  date not null,
  end_date    date not null,
  kind        text not null default 'full' check (kind in ('full', 'reduced')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists player_absences_guild_idx on public.player_absences (guild);
create index if not exists player_absences_uid_idx on public.player_absences (uid);

alter table public.player_absences enable row level security;

-- 2. RLS: SELECT only for admins of the guild (or super admins).
--    Players never read the table directly: their writes go through the
--    member-portal edge function (service_role), which validates identity.
drop policy if exists abs_admin_select on public.player_absences;
create policy abs_admin_select on public.player_absences
  for select to authenticated
  using (
    exists (
      select 1 from public.accounts a
      where a.auth_user_id = auth.uid()
        and a.role in ('super_admin', 'guild_admin')
        and (a.role = 'super_admin' or a.guild = guild)
    )
  );

-- No INSERT/UPDATE/DELETE policies: all writes are handled by the edge
-- function with service_role (which bypasses RLS) after JWT validation.

-- 3. Helper used by the edge function: list absence rows for a player.
create or replace function public.gm_get_player_absences(p_uid text)
 returns table(id uuid, guild text, pseudo text, start_date date, end_date date, kind text, note text, created_at timestamptz)
 language sql
 security definer
 set search_path to ''
as $function$
  select a.id, a.guild, a.pseudo, a.start_date, a.end_date, a.kind, a.note, a.created_at
  from public.player_absences a
  where a.uid = p_uid
  order by a.start_date desc;
$function$;

-- 4. Helper used by the edge function: upsert an absence row (delete first
--    if the date range is empty/cleared).
create or replace function public.gm_upsert_player_absence(
  p_guild text,
  p_pseudo text,
  p_uid text,
  p_id uuid,
  p_start_date date,
  p_end_date date,
  p_kind text,
  p_note text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_dates');
  end if;

  if p_id is not null then
    -- Update only rows belonging to this player
    update public.player_absences
    set start_date = p_start_date,
        end_date   = p_end_date,
        kind       = coalesce(nullif(p_kind, ''), 'full'),
        note       = nullif(p_note, ''),
        updated_at = now()
    where id = p_id and uid = p_uid;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  else
    insert into public.player_absences(guild, pseudo, uid, start_date, end_date, kind, note)
    values (p_guild, p_pseudo, p_uid, p_start_date, p_end_date, coalesce(nullif(p_kind, ''), 'full'), nullif(p_note, ''));
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

-- 5. Helper used by the edge function: delete an absence row.
create or replace function public.gm_delete_player_absence(p_id uuid, p_uid text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  delete from public.player_absences where id = p_id and uid = p_uid;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- 6. Lock down: service_role only (edge functions call these).
revoke all on function
  public.gm_get_player_absences(text),
  public.gm_upsert_player_absence(text, text, text, uuid, date, date, text, text),
  public.gm_delete_player_absence(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.gm_get_player_absences(text),
  public.gm_upsert_player_absence(text, text, text, uuid, date, date, text, text),
  public.gm_delete_player_absence(uuid, text)
to service_role;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
