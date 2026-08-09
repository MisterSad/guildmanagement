-- 20260808140000_harden_tenancy_constraints.sql
-- SaaS hardening, applies to every tenant.
--
-- 1. gm_cross_guild_ranking is super_admin-only by body check but was
--    executable by anon/authenticated/PUBLIC. Restrict to authenticated
--    (super_admin callers) and service_role.
-- 2. join_code_hash must be globally unique: one join code can never resolve
--    to an ambiguous guild.
-- 3. accounts.guild is NULLable (needed for super_admin), but every other
--    role must carry a guild. A partial check constraint enforces that.

-- 1. Grants on gm_cross_guild_ranking
revoke all on function public.gm_cross_guild_ranking()
  from public, anon, authenticated;
grant execute on function public.gm_cross_guild_ranking()
  to authenticated, service_role;

-- 2. Unique join code hash (NULLs stay allowed, only real hashes must be unique)
drop index if exists guild_config_join_code_hash_unique;
create unique index guild_config_join_code_hash_unique
  on public.guild_config (value)
  where key = 'join_code_hash' and value is not null and value <> '';

-- 3. accounts.guild: required for every role except super_admin
alter table public.accounts drop constraint if exists accounts_guild_required;
alter table public.accounts
  add constraint accounts_guild_required
  check (role = 'super_admin' or guild is not null);

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
