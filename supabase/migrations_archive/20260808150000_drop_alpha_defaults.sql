-- 20260808150000_drop_alpha_defaults.sql
-- Remove silent 'ALPHA' defaults on tenant tables. Every insert must provide
-- guild explicitly (the db.from wrapper injects it for tenantTables, and the
-- player_name_history insert was fixed to pass the active guild). A missing
-- guild now fails loudly instead of silently landing in ALPHA.

alter table public.guild_config             alter column guild drop default;
alter table public.shadowfront_signups      alter column guild drop default;
alter table public.push_subscriptions       alter column guild drop default;
alter table public.event_reminders_sent     alter column guild drop default;
alter table public.discord_notifications_sent alter column guild drop default;
alter table public.player_name_history      alter column guild drop default;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
