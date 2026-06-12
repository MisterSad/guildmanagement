-- ============================================================================
-- P0 SECURITY HARDENING — saas_strategy.md §4 (Chantier 0).
-- Applied to production on 2026-06-12.
--
-- Fixes the issues reported by the Supabase security advisors:
--   * guild_config fully exposed (RLS disabled) while the publishable key is
--     public → anyone could read/replace the Discord webhook, coefficients
--     and reminder locks.
--   * RPCs executable by anonymous visitors (push-subscription spam, history
--     reads, legacy reminder trigger).
--   * Mutable search_path on two SECURITY DEFINER functions.
--   * Legacy plaintext accounts.password column (all auth paths use
--     password_enc exclusively; verified before dropping).
--
-- Deliberately NOT done here:
--   * pg_net stays in the public schema: the event-reminders-tick pg_cron job
--     depends on it; relocating the extension on a live project is not worth
--     the risk. Accepted advisor warning.
--   * "Leaked password protection" is a dashboard/auth setting, not SQL.
-- ============================================================================

-- 1. guild_config: enable RLS. Reads for any signed-in user (R4s need the
--    coefficients for stats), writes restricted to R5 via the JWT app_role
--    claim minted by the auth-login edge function. The event-reminders edge
--    function uses service_role and bypasses RLS.
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

-- 2. RPC exposure.
revoke execute on function public.save_push_subscription(text, text, text, text) from anon;
revoke execute on function public.list_event_sessions() from public, anon;
revoke execute on function public.check_and_send_discord_reminders() from public, anon, authenticated;

-- 3. search_path hardening (both functions already schema-qualify their
--    cross-schema references: net.http_post, vault.decrypted_secrets).
alter function public.list_event_sessions() set search_path = 'public';
alter function public.check_and_send_discord_reminders() set search_path = 'public';

-- 4. Drop the legacy plaintext password column. Verified on prod before
--    applying: 6/6 accounts have password_enc set, and gm_check_login /
--    gm_admin_list / gm_admin_upsert read password_enc only.
alter table public.accounts drop column if exists password;
