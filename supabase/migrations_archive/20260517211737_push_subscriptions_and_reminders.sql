-- Anonymous per-device Web Push subscriptions
create table if not exists public.push_subscriptions (
    id         bigint generated always as identity primary key,
    endpoint   text not null unique,
    p256dh     text not null,
    auth       text not null,
    ua         text,
    created_at timestamptz not null default now(),
    last_seen  timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
-- No anon/authenticated policies: clients never touch the table directly.
-- Writes go through save_push_subscription(); reads/deletes are service-role only.

-- Dedupe ledger: one row per (event, occurrence, offset) reminder actually sent
create table if not exists public.event_reminders_sent (
    event_name text        not null,
    start_at   timestamptz not null,
    offset_min integer     not null,
    sent_at    timestamptz not null default now(),
    primary key (event_name, start_at, offset_min)
);
alter table public.event_reminders_sent enable row level security;
-- Service-role only (no policies).

-- Client-callable upsert for a device subscription (anonymous).
create or replace function public.save_push_subscription(
    p_endpoint text,
    p_p256dh   text,
    p_auth     text,
    p_ua       text default null
) returns void
language sql
security definer
set search_path = public
as $$
    insert into public.push_subscriptions (endpoint, p256dh, auth, ua)
    values (p_endpoint, p_p256dh, p_auth, p_ua)
    on conflict (endpoint) do update
        set p256dh    = excluded.p256dh,
            auth      = excluded.auth,
            ua        = excluded.ua,
            last_seen = now();
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public;
grant execute on function public.save_push_subscription(text, text, text, text) to anon, authenticated;;
