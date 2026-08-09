-- 20260809150000_payments_disabled_flag.sql
-- Per-guild flag to disable the self-service subscription/payment flow.
-- Applies to every tenant; DEMO is turned off because it is a public
-- preview tenant shared in articles (no real purchase should be possible).

alter table public.guilds
  add column if not exists payments_disabled boolean not null default false;

update public.guilds
  set payments_disabled = true
  where id = 'DEMO';

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
