-- ============================================================================
-- MULTI-TENANT MIGRATION: saas_strategy.md §5 (Chantier 1).
--
-- STAGED, NOT APPLIED TO PRODUCTION. Lives in migrations_staged/ so that
--     `supabase db push` cannot pick it up by accident. Apply it only by
--     following docs/cutover-runbook.md (staging rehearsal first), together
--     with the functions_staged/ edge functions and the frontend that ships
--     with the same release.
--
-- What it does:
--   1. guilds table (tenant root) + subscription lifecycle fields
--   2. Seeds the RAD guild and backfills every existing row into it
--   3. guild_id on all business tables, composite FKs (guild_id, pseudo)
--   4. Tenant-isolation RLS everywhere (replaces blanket allow-all),
--      R5-only rules, and write-gating by subscription status
--   5. notification_locks (replaces guild_config 'sent_*' rows)
--   6. guild_event_schedules + per-guild seeds replicating the schedule
--      currently hardcoded in the event-reminders function
--   7. Tenant-aware rewrites of the app RPCs
--   8. Drops dead tables (weekly_scores, event_reminders_sent,
--      discord_notifications_sent)
-- ============================================================================

-- ─── 1. Tenant root ─────────────────────────────────────────────────────────

create table public.guilds (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  slug                     text unique not null,
  game_server              text,
  display_timezone         text not null default 'UTC',
  subscription_status      text not null default 'trialing'
    check (subscription_status in ('trialing','active','past_due','read_only','canceled')),
  trial_ends_at            timestamptz,
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz not null default now()
);

-- Fixed UUID for the founding tenant: greppable in logs and runbooks.
insert into public.guilds (id, name, slug, subscription_status)
values ('00000000-0000-4000-8000-000000000001', 'RAD', 'rad', 'active');

-- ─── 2. JWT helpers ──────────────────────────────────────────────────────────

create or replace function public.gmt_jwt_guild_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif((auth.jwt() -> 'app_metadata') ->> 'guild_id', '')::uuid;
$$;

create or replace function public.gmt_jwt_role() returns text
language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata') ->> 'app_role', '');
$$;

-- Write-gating by subscription (saas_strategy.md §8.3): SELECT stays open for
-- read_only/canceled tenants, INSERT/UPDATE/DELETE require a live status.
create or replace function public.guild_is_writable(g uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guilds
    where id = g and subscription_status in ('trialing','active','past_due')
  );
$$;
revoke execute on function public.guild_is_writable(uuid) from public, anon;
grant  execute on function public.guild_is_writable(uuid) to authenticated;

-- Auto-stamp guild_id from the JWT on INSERT so existing client code that
-- doesn't know about tenancy keeps working unchanged.
create or replace function public.gmt_set_guild_id() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.guild_id is null then
    new.guild_id := public.gmt_jwt_guild_id();
  end if;
  return new;
end $$;

-- ─── 3. guild_id everywhere + backfill ──────────────────────────────────────

do $$
declare
  rad constant uuid := '00000000-0000-4000-8000-000000000001';
  tbl text;
begin
  foreach tbl in array array[
    'accounts', 'guild_members', 'event_status', 'event_participants',
    'shadowfront_squads', 'sanctions', 'push_subscriptions', 'guild_config'
  ] loop
    execute format('alter table public.%I add column guild_id uuid references public.guilds(id) on delete cascade', tbl);
    execute format('update public.%I set guild_id = %L', tbl, rad);
    execute format('alter table public.%I alter column guild_id set not null', tbl);
    execute format('create index %I on public.%I (guild_id)', tbl || '_guild_id_idx', tbl);
    execute format('create trigger %I before insert on public.%I for each row execute function public.gmt_set_guild_id()',
                   tbl || '_set_guild', tbl);
  end loop;
end $$;

-- Uniqueness becomes per-guild; FKs become composite so a pseudo rename or
-- removal cascades within the right tenant only.
alter table public.guild_members drop constraint guild_members_pseudo_key;
alter table public.guild_members add constraint guild_members_guild_pseudo_key unique (guild_id, pseudo);

alter table public.event_participants drop constraint event_participants_pseudo_fkey;
alter table public.event_participants
  add constraint event_participants_guild_pseudo_fkey
  foreign key (guild_id, pseudo) references public.guild_members (guild_id, pseudo)
  on update cascade on delete cascade;

alter table public.shadowfront_squads drop constraint shadowfront_squads_pseudo_fkey;
alter table public.shadowfront_squads
  add constraint shadowfront_squads_guild_pseudo_fkey
  foreign key (guild_id, pseudo) references public.guild_members (guild_id, pseudo)
  on update cascade on delete cascade;
alter table public.shadowfront_squads drop constraint shadowfront_squads_week_start_pseudo_key;
alter table public.shadowfront_squads
  add constraint shadowfront_squads_guild_week_pseudo_key unique (guild_id, week_start, pseudo);

alter table public.sanctions drop constraint sanctions_pseudo_fkey;
alter table public.sanctions
  add constraint sanctions_guild_pseudo_fkey
  foreign key (guild_id, pseudo) references public.guild_members (guild_id, pseudo)
  on update cascade on delete cascade;

alter table public.event_status drop constraint event_status_event_name_key;
alter table public.event_status add constraint event_status_guild_event_key unique (guild_id, event_name);

create index event_participants_guild_week_idx    on public.event_participants (guild_id, week_start);
create index event_participants_guild_session_idx on public.event_participants (guild_id, session_id);

-- Account identifiers stay globally unique (id is the PK) so the login page
-- does not need a guild field; each account belongs to exactly one guild.

-- guild_config: key/value becomes per-guild; reminder locks move out first.
create table public.notification_locks (
  guild_id   uuid not null references public.guilds(id) on delete cascade,
  lock_key   text not null,
  status     text not null check (status in ('sending','sent')),
  created_at timestamptz not null default now(),
  primary key (guild_id, lock_key)
);
alter table public.notification_locks enable row level security; -- service_role only

insert into public.notification_locks (guild_id, lock_key, status, created_at)
select guild_id, key, case when value in ('sending','sent') then value else 'sent' end, updated_at
from public.guild_config
where key like 'sent\_%' escape '\';

delete from public.guild_config where key like 'sent\_%' escape '\';

alter table public.guild_config drop constraint guild_config_pkey;
alter table public.guild_config add primary key (guild_id, key);

-- ─── 4. Per-guild reminder schedules (saas_strategy.md §10) ────────────────
-- `kind` selects the message template in the event-reminders function.
-- `requires_event` gates the slot on event_status.is_active for that event
-- this week (NULL = always armed). Times are UTC; offsets are minutes before
-- the slot at which a reminder fires (0 = "starts now" message).

create table public.guild_event_schedules (
  id               bigint generated always as identity primary key,
  guild_id         uuid not null references public.guilds(id) on delete cascade,
  kind             text not null check (kind in
    ('gvg_war_prism','gvg_war_fortress','svs_garrison','svs_battle','calamity_round','custom')),
  label            text,
  day_utc          smallint not null check (day_utc between 0 and 6),
  time_utc         time not null,
  reminder_offsets integer[] not null default '{5,0}',
  requires_event   text,
  enabled          boolean not null default true
);
create index guild_event_schedules_guild_idx on public.guild_event_schedules (guild_id);
alter table public.guild_event_schedules enable row level security;
create trigger guild_event_schedules_set_guild before insert on public.guild_event_schedules
  for each row execute function public.gmt_set_guild_id();

-- Seed: replicate the schedule previously hardcoded in event-reminders for RAD.
do $$
declare
  rad constant uuid := '00000000-0000-4000-8000-000000000001';
  r int;
begin
  -- GvG Saturday (UTC), gated on the GvG event being active this week.
  insert into public.guild_event_schedules (guild_id, kind, label, day_utc, time_utc, reminder_offsets, requires_event) values
    (rad, 'gvg_war_prism',    'War Prism',    6, '00:00', '{5,0}', 'GvG'),
    (rad, 'gvg_war_prism',    'War Prism',    6, '01:00', '{5,0}', 'GvG'),
    (rad, 'gvg_war_fortress', 'War Fortress', 6, '10:00', '{5,0}', 'GvG'),
    (rad, 'gvg_war_prism',    'War Prism',    6, '13:00', '{5,0}', 'GvG'),
    (rad, 'gvg_war_prism',    'War Prism',    6, '14:00', '{5,0}', 'GvG'),
    (rad, 'gvg_war_fortress', 'War Fortress', 6, '22:00', '{5,0}', 'GvG');

  -- SvS: Friday-evening garrison nudges + Saturday battle countdown.
  insert into public.guild_event_schedules (guild_id, kind, label, day_utc, time_utc, reminder_offsets, requires_event) values
    (rad, 'svs_garrison', 'Garrison', 5, '20:00', '{0}', 'SvS'),
    (rad, 'svs_garrison', 'Garrison', 5, '21:00', '{0}', 'SvS'),
    (rad, 'svs_garrison', 'Garrison', 5, '22:00', '{0}', 'SvS'),
    (rad, 'svs_garrison', 'Garrison', 5, '23:00', '{0}', 'SvS'),
    (rad, 'svs_battle',   'Battle',   6, '14:00', '{30,15,5,0}', 'SvS');

  -- Calamity Befalls: 16 rounds, Tue 00:00 to Wed 21:00 UTC, every 3h,
  -- 5-minute reminder each. Not gated on an event session.
  for r in 1..16 loop
    insert into public.guild_event_schedules (guild_id, kind, label, day_utc, time_utc, reminder_offsets, requires_event)
    values (rad, 'calamity_round', 'Round ' || r,
            case when r <= 8 then 2 else 3 end,
            make_time(((r - 1) % 8) * 3, 0, 0),
            '{5}', null);
  end loop;
end $$;

-- ─── 5. RLS: tenant isolation replaces blanket allow-all ───────────────────

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'guild_members', 'event_status', 'event_participants',
    'shadowfront_squads', 'sanctions'
  ] loop
    execute format('drop policy if exists gm_authenticated_all on public.%I', tbl);
    execute format($p$create policy tenant_select on public.%I
      for select to authenticated
      using (guild_id = public.gmt_jwt_guild_id())$p$, tbl);
    execute format($p$create policy tenant_insert on public.%I
      for insert to authenticated
      with check (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id))$p$, tbl);
    execute format($p$create policy tenant_update on public.%I
      for update to authenticated
      using (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id))
      with check (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id))$p$, tbl);
  end loop;
end $$;

-- DELETE rules per the role matrix (saas_strategy.md §6.3):
-- members / squads / sanctions are R4-manageable; event history wipes are R5.
create policy tenant_delete on public.guild_members
  for delete to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id));
create policy tenant_delete on public.shadowfront_squads
  for delete to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id));
create policy tenant_delete on public.sanctions
  for delete to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id));
create policy tenant_delete_r5 on public.event_participants
  for delete to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id)
         and public.gmt_jwt_role() = 'R5');
create policy tenant_delete_r5 on public.event_status
  for delete to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id)
         and public.gmt_jwt_role() = 'R5');

-- guild_config: rescope the P0 policies to the tenant.
drop policy if exists gc_read   on public.guild_config;
drop policy if exists gc_insert on public.guild_config;
drop policy if exists gc_update on public.guild_config;
drop policy if exists gc_delete on public.guild_config;
create policy gc_read on public.guild_config
  for select to authenticated using (guild_id = public.gmt_jwt_guild_id());
create policy gc_insert on public.guild_config
  for insert to authenticated
  with check (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id)
              and public.gmt_jwt_role() = 'R5');
create policy gc_update on public.guild_config
  for update to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.gmt_jwt_role() = 'R5')
  with check (guild_id = public.gmt_jwt_guild_id() and public.guild_is_writable(guild_id)
              and public.gmt_jwt_role() = 'R5');
create policy gc_delete on public.guild_config
  for delete to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.gmt_jwt_role() = 'R5');

-- guilds: members can read their own guild (name, subscription banner);
-- all writes go through service-role functions (billing webhook, onboarding).
alter table public.guilds enable row level security;
create policy guild_self_read on public.guilds
  for select to authenticated using (id = public.gmt_jwt_guild_id());

-- schedules: readable by the guild, writable by its R5.
create policy sched_select on public.guild_event_schedules
  for select to authenticated using (guild_id = public.gmt_jwt_guild_id());
create policy sched_write on public.guild_event_schedules
  for all to authenticated
  using (guild_id = public.gmt_jwt_guild_id() and public.gmt_jwt_role() = 'R5'
         and public.guild_is_writable(guild_id))
  with check (guild_id = public.gmt_jwt_guild_id() and public.gmt_jwt_role() = 'R5'
              and public.guild_is_writable(guild_id));

-- ─── 6. Tenant-aware RPCs ───────────────────────────────────────────────────

create or replace function public.populate_event_participants(p_event_name text, p_session_id text, p_week_start date)
returns integer
language plpgsql security definer
set search_path = 'public'
as $$
declare
  g uuid := public.gmt_jwt_guild_id();
  inserted_count integer;
begin
  if g is null then raise exception 'no guild in token'; end if;
  if p_event_name is null or p_session_id is null or p_week_start is null then
    raise exception 'event_name, session_id and week_start are required';
  end if;
  if not public.guild_is_writable(g) then raise exception 'guild is read-only'; end if;

  with ins as (
    insert into event_participants (guild_id, event_name, week_start, session_id, pseudo, participated, score)
    select g, p_event_name, p_week_start, p_session_id, gm.pseudo, 0, null
    from guild_members gm
    where gm.guild_id = g
      and not exists (
        select 1 from event_participants ep
        where ep.guild_id = g
          and ep.event_name = p_event_name
          and ep.session_id = p_session_id
          and ep.pseudo = gm.pseudo
      )
    returning 1
  )
  select count(*) into inserted_count from ins;
  return inserted_count;
end $$;

create or replace function public.list_event_weeks()
returns table(week_start date)
language sql security definer
set search_path = 'public'
as $$
  select distinct week_start
  from event_participants
  where guild_id = public.gmt_jwt_guild_id()
    and week_start is not null
  order by week_start desc;
$$;

create or replace function public.list_event_sessions()
returns table(event_name text, session_id text, week_start text, participants bigint, participated_count bigint, total_score numeric)
language sql security definer
set search_path = 'public'
as $$
  select
    ep.event_name,
    ep.session_id,
    ep.week_start::text,
    count(*) as participants,
    sum(ep.participated) as participated_count,
    sum(coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0)) as total_score
  from event_participants ep
  left join event_status es
         on es.guild_id = ep.guild_id
        and ep.event_name = es.event_name
        and ep.session_id = es.session_id
        and es.is_active = true
  where ep.guild_id = public.gmt_jwt_guild_id()
    and es.session_id is null
    and ep.session_id is not null
  group by ep.event_name, ep.session_id, ep.week_start
  having sum(coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0)) > 0
      or sum(ep.participated) > 0
  order by ep.session_id desc;
$$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null::text)
returns void
language plpgsql security definer
set search_path = 'public'
as $$
declare g uuid := public.gmt_jwt_guild_id();
begin
  if g is null then raise exception 'no guild in token'; end if;
  insert into push_subscriptions (guild_id, endpoint, p256dh, auth, ua)
  values (g, p_endpoint, p_p256dh, p_auth, p_ua)
  on conflict (endpoint) do update
      set guild_id  = excluded.guild_id,
          p256dh    = excluded.p256dh,
          auth      = excluded.auth,
          ua        = excluded.ua,
          last_seen = now();
end $$;

-- Account helpers gain tenant awareness (called by edge functions v2).
create or replace function public.gm_account_info(p_id text)
returns table(role text, guild_id uuid)
language sql security definer
set search_path = ''
as $$
  select coalesce(a.role, 'R4'), a.guild_id
  from public.accounts a
  where a.id = p_id;
$$;
revoke execute on function public.gm_account_info(text) from public, anon, authenticated;

create or replace function public.gm_admin_list(p_guild_id uuid)
returns table(id text, role text, created_at timestamptz)
language sql security definer
set search_path = ''
as $$
  select a.id, coalesce(a.role, 'R4'), a.created_at
  from public.accounts a
  where a.guild_id = p_guild_id
  order by a.id;
$$;
-- NOTE: passwords are intentionally no longer returned (saas_strategy.md §6.2);
-- the UI switches from "reveal" to "regenerate". The old zero-arg overload is
-- dropped below.
drop function if exists public.gm_admin_list();

create or replace function public.gm_admin_upsert(p_guild_id uuid, p_id text, p_password text, p_role text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.accounts(guild_id, id, role, password_enc, created_at)
  values (
    p_guild_id,
    p_id,
    coalesce(nullif(p_role, ''), 'R4'),
    extensions.pgp_sym_encrypt(p_password, (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')),
    now())
  on conflict (id) do update
    set role         = coalesce(nullif(p_role, ''), 'R4'),
        password_enc = extensions.pgp_sym_encrypt(p_password, (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'))
    where accounts.guild_id = p_guild_id;
end $$;
drop function if exists public.gm_admin_upsert(text, text, text);

create or replace function public.gm_admin_delete(p_guild_id uuid, p_id text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_uuid uuid;
begin
  select auth_user_id into v_uuid from public.accounts where id = p_id and guild_id = p_guild_id;
  delete from public.accounts where id = p_id and guild_id = p_guild_id;
  return v_uuid;
end $$;
drop function if exists public.gm_admin_delete(text);

-- ─── 7. Dead tables ─────────────────────────────────────────────────────────
drop table if exists public.weekly_scores;
drop table if exists public.event_reminders_sent;
drop table if exists public.discord_notifications_sent;
