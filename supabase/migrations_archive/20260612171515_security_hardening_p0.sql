-- P0 SECURITY HARDENING — saas_strategy.md §4 (Chantier 0). 2026-06-12.

alter table public.guild_config enable row level security;

drop policy if exists gc_read on public.guild_config;
create policy gc_read on public.guild_config
  for select to authenticated
  using (true);

drop policy if exists gc_insert on public.guild_config;
create policy gc_insert on public.guild_config
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R5');

drop policy if exists gc_update on public.guild_config;
create policy gc_update on public.guild_config
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R5')
  with check ((auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R5');

drop policy if exists gc_delete on public.guild_config;
create policy gc_delete on public.guild_config
  for delete to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R5');

revoke execute on function public.save_push_subscription(text, text, text, text) from anon;
revoke execute on function public.list_event_sessions() from public, anon;
revoke execute on function public.check_and_send_discord_reminders() from public, anon, authenticated;

alter function public.list_event_sessions() set search_path = 'public';
alter function public.check_and_send_discord_reminders() set search_path = 'public';

alter table public.accounts drop column if exists password;;
