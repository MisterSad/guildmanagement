-- 20260809120000_push_prefs.sql
-- Contextual push reminders with per-player preferences.
--
-- 1. push_subscriptions gets a `pseudo` column so a subscription is bound to
--    the authenticated player (resolved server-side in save_push_subscription).
-- 2. player_push_prefs stores per-player reminder preferences: which event
--    types the player wants to be notified about (default: all).
-- 3. save_push_subscription resolves guild + pseudo from auth (never trusts
--    the client) and records the guild so web push can target the right
--    tenant. The old public callers (push.js) still work, but now the
--    subscription is correctly attributed.

-- 1. push_subscriptions.pseudo
alter table public.push_subscriptions
  add column if not exists pseudo text;

create index if not exists push_subscriptions_guild_pseudo_idx
  on public.push_subscriptions (guild, pseudo);

-- 2. player_push_prefs
create table if not exists public.player_push_prefs (
  guild text not null,
  pseudo text not null,
  event_types text[] not null default array['events','glory','challenges'],
  updated_at timestamptz not null default now(),
  primary key (guild, pseudo)
);

alter table public.player_push_prefs enable row level security;

drop policy if exists player_push_prefs_own on public.player_push_prefs;
create policy player_push_prefs_own
  on public.player_push_prefs
  for select
  to authenticated
  using (guild = coalesce((select guild from public.accounts a where a.auth_user_id = auth.uid()), ''));

drop policy if exists player_push_prefs_write on public.player_push_prefs;
create policy player_push_prefs_write
  on public.player_push_prefs
  for insert
  to authenticated
  with check (guild = coalesce((select guild from public.accounts a where a.auth_user_id = auth.uid()), ''));

drop policy if exists player_push_prefs_update on public.player_push_prefs;
create policy player_push_prefs_update
  on public.player_push_prefs
  for update
  to authenticated
  using (guild = coalesce((select guild from public.accounts a where a.auth_user_id = auth.uid()), ''))
  with check (guild = coalesce((select guild from public.accounts a where a.auth_user_id = auth.uid()), ''));

revoke all on public.player_push_prefs from anon;
grant select, insert, update on public.player_push_prefs to authenticated;

-- 3. save_push_subscription: resolve guild + pseudo server-side.
create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_ua text default null::text
)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_guild text;
  v_pseudo text;
begin
  select a.guild, gm.pseudo
    into v_guild, v_pseudo
  from public.accounts a
  left join public.guild_members gm
    on gm.guild = a.guild and gm.uid = a.uid
  where a.auth_user_id = auth.uid();

  insert into public.push_subscriptions (endpoint, p256dh, auth, ua, guild, pseudo)
  values (p_endpoint, p_p256dh, p_auth, p_ua, v_guild, v_pseudo)
  on conflict (guild, endpoint) do update
    set p256dh    = excluded.p256dh,
        auth      = excluded.auth,
        ua        = excluded.ua,
        pseudo    = excluded.pseudo,
        last_seen = now();
end;
$function$;

revoke all on function public.save_push_subscription(text, text, text, text)
  from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text)
  to authenticated;

-- RPC: read the caller's push preferences.
create or replace function public.gm_get_push_prefs()
 returns table(guild text, pseudo text, event_types text[])
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  return query
  select p.guild, p.pseudo, p.event_types
  from public.player_push_prefs p
  join public.accounts a on a.auth_user_id = auth.uid()
    and a.guild = p.guild
  where lower(p.pseudo) = lower(coalesce((select gm.pseudo from public.guild_members gm where gm.guild = a.guild and gm.uid = a.uid limit 1), ''));
end;
$function$;

revoke all on function public.gm_get_push_prefs() from public, anon;
grant execute on function public.gm_get_push_prefs() to authenticated;

-- RPC: set the caller's push preferences.
create or replace function public.gm_set_push_prefs(p_event_types text[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_guild text;
  v_pseudo text;
begin
  select a.guild, gm.pseudo into v_guild, v_pseudo
  from public.accounts a
  left join public.guild_members gm on gm.guild = a.guild and gm.uid = a.uid
  where a.auth_user_id = auth.uid();

  if v_guild is null or v_pseudo is null then
    return jsonb_build_object('ok', false, 'error', 'player_not_found');
  end if;

  insert into public.player_push_prefs (guild, pseudo, event_types, updated_at)
  values (v_guild, v_pseudo, coalesce(p_event_types, array['events','glory','challenges']), now())
  on conflict (guild, pseudo) do update
    set event_types = excluded.event_types, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.gm_set_push_prefs(text[]) from public, anon;
grant execute on function public.gm_set_push_prefs(text[]) to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
