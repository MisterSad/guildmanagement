-- ============================================================================
-- BASELINE: snapshot of the production schema as of 2026-06-12.
--
-- Purpose: make the repo the source of truth (saas_strategy.md §4 / §14.1).
-- This file recreates the CURRENT production state on a FRESH project
-- (staging, local dev). It must NOT be executed against the existing
-- production database. Mark it as already applied instead:
--
--   supabase migration repair --status applied 20260612000100
--
-- Out-of-band dependencies (not creatable via SQL alone):
--   * Vault secrets:  gm_accounts_key, vapid_public_key, vapid_private_key,
--                     vapid_subject, push_cron_secret
--   * Edge functions: auth-login, admin-accounts, event-reminders
--     (sources in supabase/functions/, deploy with `supabase functions deploy`)
--   * Edge function env: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
-- ============================================================================

-- ─── Extensions ─────────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;          -- NOTE: lives in public on prod (see hardening notes)
create extension if not exists pg_cron;

-- ─── Tables ─────────────────────────────────────────────────────────────────

-- Dashboard accounts (R5/R4). Auth flow: auth-login edge function verifies the
-- password via gm_check_login, then signs into a shadow GoTrue user whose
-- app_metadata carries { app_role, account_id }.
create table public.accounts (
  id                text primary key,
  created_at        timestamptz default now(),
  role              text default 'R4',
  password_enc      bytea,         -- pgp_sym_encrypt(password, vault:gm_accounts_key)
  auth_user_id      uuid,          -- shadow auth.users id
  gotrue_secret_enc bytea          -- pgp_sym_encrypt(gotrue password, vault:gm_accounts_key)
  -- NOTE: a legacy plaintext `password text` column existed in prod;
  -- it is dropped by 20260612000200_security_hardening_p0.sql.
);

create table public.guild_members (
  id         bigserial primary key,
  pseudo     text not null unique,
  created_at timestamptz not null default now(),
  uid        text
);

create table public.event_status (
  id         bigserial primary key,
  event_name text not null unique,
  is_active  boolean not null default false,
  updated_at timestamptz not null default now(),
  session_id text,
  stage      text,
  start_at   timestamptz
);
comment on column public.event_status.start_at is
  'Planned UTC start time of the event occurrence (set at launch for Shadowfront / Defend Trade Route / Arms Race). Drives the Overview upcoming list and future reminders.';

create table public.event_participants (
  id           bigserial primary key,
  event_name   text not null,
  week_start   date not null,
  pseudo       text not null references public.guild_members(pseudo)
                 on update cascade on delete cascade,
  participated integer not null default 0,
  score        integer,
  session_id   text,
  score_prep   integer,
  score_pvp    integer
);

create table public.shadowfront_squads (
  id         bigserial primary key,
  week_start date not null,
  pseudo     text not null references public.guild_members(pseudo)
               on update cascade on delete cascade,
  squad      text not null check (squad in ('squad1', 'squad2')),
  role       text not null check (role in ('participant', 'reserve')),
  session_id text,
  unique (week_start, pseudo)
);

-- Legacy (unused by the current frontend; candidate for removal at cutover).
create table public.weekly_scores (
  id          bigserial primary key,
  week_start  date not null,
  pseudo      text not null references public.guild_members(pseudo)
                on update cascade on delete cascade,
  score_20    numeric not null default 0,
  events_done integer default 0,
  events_total integer default 0,
  glory_score integer default 0,
  computed_at timestamptz default now(),
  unique (week_start, pseudo)
);

create table public.sanctions (
  id         uuid primary key default gen_random_uuid(),
  pseudo     text not null references public.guild_members(pseudo)
               on update cascade on delete cascade,
  comment    text,
  created_at timestamptz default now(),
  created_by text
);

create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- Key/value config. Also (ab)used as the lock table for reminder idempotency
-- (keys `sent_*`); to be split into notification_locks at the multi-tenant
-- cutover (saas_strategy.md §5.1).
create table public.guild_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default timezone('utc', now())
);

-- Legacy idempotency tables (superseded by guild_config locks; candidates
-- for removal at cutover).
create table public.event_reminders_sent (
  event_name text not null,
  start_at   timestamptz not null,
  offset_min integer not null,
  sent_at    timestamptz not null default now(),
  primary key (event_name, start_at, offset_min)
);

create table public.discord_notifications_sent (
  event_id      text not null,
  reminder_type text not null,
  sent_at       timestamptz not null default now(),
  primary key (event_id, reminder_type)
);

-- ─── Row Level Security ─────────────────────────────────────────────────────
-- Prod state as of the snapshot: blanket allow-all for `authenticated` on the
-- business tables (tightened progressively; see hardening + multi-tenant
-- migrations). guild_config RLS is enabled by 20260612000200.

alter table public.accounts                   enable row level security;  -- no policy: service_role only
alter table public.guild_members              enable row level security;
alter table public.event_status               enable row level security;
alter table public.event_participants         enable row level security;
alter table public.shadowfront_squads         enable row level security;
alter table public.weekly_scores              enable row level security;
alter table public.sanctions                  enable row level security;
alter table public.push_subscriptions         enable row level security;  -- no policy: RPC/service_role only
alter table public.event_reminders_sent       enable row level security;  -- no policy
alter table public.discord_notifications_sent enable row level security;  -- no policy

create policy gm_authenticated_all on public.guild_members
  for all to authenticated using (true) with check (true);
create policy gm_authenticated_all on public.event_status
  for all to authenticated using (true) with check (true);
create policy gm_authenticated_all on public.event_participants
  for all to authenticated using (true) with check (true);
create policy gm_authenticated_all on public.shadowfront_squads
  for all to authenticated using (true) with check (true);
create policy gm_authenticated_all on public.weekly_scores
  for all to authenticated using (true) with check (true);
create policy gm_authenticated_all on public.sanctions
  for all to authenticated using (true) with check (true);

-- ─── Functions ──────────────────────────────────────────────────────────────

-- Account auth helpers (service_role only; called by edge functions).

CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.role
  from public.accounts a
  where a.id = p_id
    and a.password_enc is not null
    and extensions.pgp_sym_decrypt(
          a.password_enc,
          (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')
        ) = p_password
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.gm_get_shadow(p_id text)
 RETURNS TABLE(auth_user_id uuid, gotrue_secret text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.auth_user_id,
         case when a.gotrue_secret_enc is null then null
              else extensions.pgp_sym_decrypt(
                     a.gotrue_secret_enc,
                     (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'))
         end
  from public.accounts a
  where a.id = p_id;
$function$;

CREATE OR REPLACE FUNCTION public.gm_attach_shadow(p_id text, p_auth_user_id uuid, p_secret text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.accounts
  set auth_user_id      = p_auth_user_id,
      gotrue_secret_enc = extensions.pgp_sym_encrypt(
        p_secret,
        (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'))
  where id = p_id;
$function$;

CREATE OR REPLACE FUNCTION public.gm_admin_list()
 RETURNS TABLE(id text, role text, password text, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.id,
         coalesce(a.role, 'R4'),
         extensions.pgp_sym_decrypt(
           a.password_enc,
           (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')),
         a.created_at
  from public.accounts a
  order by a.id;
$function$;

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(p_id text, p_password text, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.accounts(id, role, password_enc, created_at)
  values (
    p_id,
    coalesce(nullif(p_role, ''), 'R4'),
    extensions.pgp_sym_encrypt(p_password, (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')),
    now())
  on conflict (id) do update
    set role         = coalesce(nullif(p_role, ''), 'R4'),
        password_enc = extensions.pgp_sym_encrypt(p_password, (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'));
end $function$;

CREATE OR REPLACE FUNCTION public.gm_admin_delete(p_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uuid uuid;
begin
  select auth_user_id into v_uuid from public.accounts where id = p_id;
  delete from public.accounts where id = p_id;
  return v_uuid;
end $function$;

-- App RPCs (callable by authenticated users).

CREATE OR REPLACE FUNCTION public.populate_event_participants(p_event_name text, p_session_id text, p_week_start date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inserted_count integer;
BEGIN
  IF p_event_name IS NULL OR p_session_id IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'event_name, session_id et week_start sont requis';
  END IF;

  WITH ins AS (
    INSERT INTO event_participants (event_name, week_start, session_id, pseudo, participated, score)
    SELECT p_event_name, p_week_start, p_session_id, gm.pseudo, 0, NULL
    FROM guild_members gm
    WHERE NOT EXISTS (
      SELECT 1 FROM event_participants ep
      WHERE ep.event_name = p_event_name
        AND ep.session_id = p_session_id
        AND ep.pseudo = gm.pseudo
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted_count FROM ins;

  RETURN inserted_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_event_weeks()
 RETURNS TABLE(week_start date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT week_start
  FROM event_participants
  WHERE week_start IS NOT NULL
  ORDER BY week_start DESC;
$function$;

CREATE OR REPLACE FUNCTION public.list_event_sessions()
 RETURNS TABLE(event_name text, session_id text, week_start text, participants bigint, participated_count bigint, total_score numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    ep.event_name,
    ep.session_id,
    ep.week_start,
    COUNT(*) as participants,
    SUM(ep.participated) as participated_count,
    SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0)) as total_score
  FROM event_participants ep
  LEFT JOIN event_status es
         ON ep.event_name = es.event_name
        AND ep.session_id = es.session_id
        AND es.is_active = true
  WHERE es.session_id IS NULL
    AND ep.session_id IS NOT NULL
  GROUP BY ep.event_name, ep.session_id, ep.week_start
  HAVING SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0)) > 0
      OR SUM(ep.participated) > 0
  ORDER BY ep.session_id DESC;
$function$;

CREATE OR REPLACE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    insert into public.push_subscriptions (endpoint, p256dh, auth, ua)
    values (p_endpoint, p_p256dh, p_auth, p_ua)
    on conflict (endpoint) do update
        set p256dh    = excluded.p256dh,
            auth      = excluded.auth,
            ua        = excluded.ua,
            last_seen = now();
$function$;

-- Service helpers.

CREATE OR REPLACE FUNCTION public.get_push_config()
 RETURNS TABLE(vapid_public text, vapid_private text, vapid_subject text, cron_secret text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
    select
        (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_public_key'),
        (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key'),
        (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_subject'),
        (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret');
$function$;

-- Legacy pg_net Discord sender (superseded by the event-reminders edge
-- function; kept for reference, locked down by the hardening migration).

CREATE OR REPLACE FUNCTION public.check_and_send_discord_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_webhook_url text;
    v_event record;
    v_diff_mins int;
    v_content text;
    v_embed_title text;
    v_embed_desc text;
    v_color int;
    v_date_formatted text;
    v_payload jsonb;
begin
    select value into v_webhook_url from public.guild_config where key = 'discord_webhook_url';
    if v_webhook_url is null or trim(v_webhook_url) = '' then
        return;
    end if;

    for v_event in
        select event_name, start_at
        from public.event_status
        where is_active = true and start_at is not null
    loop
        v_diff_mins := round(extract(epoch from (v_event.start_at::timestamptz - now())) / 60)::int;

        if v_diff_mins = 15 or v_diff_mins = 5 then
            v_date_formatted := to_char(v_event.start_at::timestamptz at time zone 'UTC', 'DY DD/MM "·" HH24:MI "UTC"');

            if v_diff_mins = 15 then
                v_content := '⏰ **Reminder:** ' || v_event.event_name || ' starts in **15 minutes**! @everyone';
                v_embed_title := '⏰ Reminder: ' || v_event.event_name || ' starts in 15 minutes!';
                v_embed_desc := 'Get ready, soldiers! Please log in and prepare for the event.';
                v_color := 16750848;
            else
                v_content := '🚨 **Immediate Reminder:** ' || v_event.event_name || ' starts in **5 minutes**! Get ready! @everyone';
                v_embed_title := '🚨 Immediate Reminder: ' || v_event.event_name || ' starts in 5 minutes!';
                v_embed_desc := 'Action time! Join your squad now!';
                v_color := 15548997;
            end if;

            v_payload := jsonb_build_object(
                'content', v_content,
                'embeds', jsonb_build_array(
                    jsonb_build_object(
                        'title', v_embed_title,
                        'description', v_embed_desc,
                        'color', v_color,
                        'fields', jsonb_build_array(
                            jsonb_build_object('name', 'Start Time (UTC)', 'value', v_date_formatted, 'inline', true),
                            jsonb_build_object('name', 'Guild Agenda', 'value', 'Please connect now.', 'inline', false)
                        ),
                        'timestamp', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'footer', jsonb_build_object('text', 'RAD Management Tool')
                    )
                )
            );

            perform net.http_post(
                url := v_webhook_url,
                headers := '{"Content-Type": "application/json"}'::jsonb,
                body := v_payload
            );
        end if;
    end loop;
end;
$function$;

-- ─── Grants (post-hardening target state) ───────────────────────────────────
revoke execute on all functions in schema public from public, anon;

grant execute on function public.populate_event_participants(text, text, date) to authenticated;
grant execute on function public.list_event_weeks()    to authenticated;
grant execute on function public.list_event_sessions() to authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
-- gm_* helpers, get_push_config, check_and_send_discord_reminders:
-- service_role only (default grant), nothing extra.

-- ─── Scheduled job ──────────────────────────────────────────────────────────
-- Ticks the event-reminders edge function every minute, authenticated via the
-- x-cron-secret header pulled from Vault.
select cron.schedule(
  'event-reminders-tick',
  '* * * * *',
  $cron$
        select net.http_post(
            url := 'https://vgweufzwmfwplusskmuf.supabase.co/functions/v1/event-reminders',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret')
            ),
            body := '{}'::jsonb
        );
  $cron$
);
