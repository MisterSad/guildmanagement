-- Migration: Player self-registration (tenant join code + pending approval)
-- Adds: accounts.uid, accounts.status, join code management in guild_config,
--        gm_register_player, gm_set_join_code, gm_approve_player_account,
--        gm_reject_player_account, updated gm_check_login + gm_admin_list.

-- 1. accounts: in-game UID + account status ('pending' | 'active' | 'rejected')
alter table public.accounts
  add column if not exists uid     text,
  add column if not exists status  text not null default 'active';

-- A UID can be claimed by at most one account (global uniqueness, like guild_members.uid).
create unique index if not exists idx_accounts_uid
  on public.accounts (uid)
  where uid is not null;

-- 2. Join code: stored as a SHA-256 hash in guild_config under key 'join_code_hash'.
--    The hash is computed with pgcrypto so the plain code never lands in the DB.

-- 3. gm_register_player: creates a 'pending' player account.
--    Validates: join code (against guild_config hash), UID exists in the guild
--    roster, UID not already claimed, identifier free, password length.
create or replace function public.gm_register_player(p_id text, p_password text, p_uid text, p_join_code text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_guild text;
  v_uid_ok boolean;
  v_uid_taken boolean;
  v_id_taken boolean;
begin
  -- Identifier sanity (same spirit as member validation)
  if p_id is null or length(p_id) < 3 or length(p_id) > 32 then
    return jsonb_build_object('ok', false, 'error', 'invalid_identifier');
  end if;
  if p_password is null or length(p_password) < 8 then
    return jsonb_build_object('ok', false, 'error', 'weak_password');
  end if;
  if p_uid is null or p_uid !~ '^[0-9]{1,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_uid');
  end if;

  -- Resolve guild from join code hash
  select gc.guild into v_guild
  from public.guild_config gc
  where gc.key = 'join_code_hash'
    and gc.value = encode(extensions.digest(p_join_code, 'sha256'), 'hex')
  limit 1;

  if v_guild is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- UID must belong to the guild roster
  select exists(
    select 1 from public.guild_members gm
    where gm.guild = v_guild and gm.uid = p_uid
  ) into v_uid_ok;

  if not v_uid_ok then
    return jsonb_build_object('ok', false, 'error', 'uid_not_in_guild');
  end if;

  -- UID must not already be claimed by another account
  select exists(
    select 1 from public.accounts a where a.uid = p_uid
  ) into v_uid_taken;

  if v_uid_taken then
    return jsonb_build_object('ok', false, 'error', 'uid_already_claimed');
  end if;

  -- Identifier must be free (case-insensitive, same as admin accounts)
  select exists(
    select 1 from public.accounts a where lower(a.id) = lower(p_id)
  ) into v_id_taken;

  if v_id_taken then
    return jsonb_build_object('ok', false, 'error', 'identifier_taken');
  end if;

  -- Create pending account (role 'member', no shadow user yet)
  insert into public.accounts(id, role, password_enc, guild, uid, status, created_at)
  values (
    p_id,
    'member',
    extensions.pgp_sym_encrypt(
      p_password,
      (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')
    ),
    v_guild,
    p_uid,
    'pending',
    now()
  );

  return jsonb_build_object('ok', true, 'status', 'pending');
end;
$function$;

-- 4. gm_set_join_code: upserts the SHA-256 hash of the tenant join code.
--    Caller must be super_admin, or a guild_admin of the target guild.
create or replace function public.gm_set_join_code(p_guild text, p_code text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
  v_guild text;
begin
  select role, guild into v_role, v_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if v_role <> 'super_admin' and not (v_role = 'guild_admin' and v_guild = p_guild) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_code is null or length(p_code) < 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into public.guild_config(guild, key, value, updated_at)
  values (
    p_guild,
    'join_code_hash',
    encode(extensions.digest(p_code, 'sha256'), 'hex'),
    now()
  )
  on conflict (guild, key) do update
    set value = excluded.value, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

-- 5. gm_approve_player_account: flips a pending account to 'active'.
--    Caller must be super_admin, or a guild_admin of the account's guild.
create or replace function public.gm_approve_player_account(p_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
  v_guild text;
  v_target_guild text;
  v_target_status text;
begin
  select role, guild into v_role, v_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select guild, status into v_target_guild, v_target_status
  from public.accounts where id = p_id;

  if v_target_guild is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_role <> 'super_admin' and not (v_role = 'guild_admin' and v_guild = v_target_guild) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_target_status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  update public.accounts set status = 'active' where id = p_id;

  return jsonb_build_object('ok', true);
end;
$function$;

-- 6. gm_reject_player_account: removes a pending account entirely.
--    Caller must be super_admin, or a guild_admin of the account's guild.
create or replace function public.gm_reject_player_account(p_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
  v_guild text;
  v_target_guild text;
  v_target_status text;
begin
  select role, guild into v_role, v_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select guild, status into v_target_guild, v_target_status
  from public.accounts where id = p_id;

  if v_target_guild is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_role <> 'super_admin' and not (v_role = 'guild_admin' and v_guild = v_target_guild) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_target_status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  delete from public.accounts where id = p_id;

  return jsonb_build_object('ok', true);
end;
$function$;

-- 7. gm_check_login: also expose status so the edge function can distinguish
--    'pending_approval' from invalid credentials.
drop function if exists public.gm_check_login(text, text);
create or replace function public.gm_check_login(p_id text, p_password text)
 returns table(canonical_id text, role text, status text)
 language sql
 security definer
 set search_path to ''
as $function$
  select a.id,
         coalesce(a.role, 'member'),
         coalesce(a.status, 'active')
  from public.accounts a
  where lower(a.id) = lower(p_id)
    and a.password_enc is not null
    and extensions.pgp_sym_decrypt(
          a.password_enc,
          (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')
        ) = p_password
  limit 1;
$function$;

-- 8. gm_admin_list: include uid + status so admins can review pending registrations.
drop function if exists public.gm_admin_list();
create or replace function public.gm_admin_list()
 returns table(id text, role text, guild text, auth_user_id uuid, uid text, status text, created_at timestamp with time zone)
 language sql
 security definer
 set search_path to ''
as $function$
  select a.id,
         coalesce(a.role, 'member'),
         a.guild,
         a.auth_user_id,
         a.uid,
         coalesce(a.status, 'active'),
         a.created_at
  from public.accounts a
  order by a.created_at desc;
$function$;

-- 9. Lock down: only service_role (Edge Functions) may execute these.
revoke all on function
  public.gm_register_player(text, text, text, text),
  public.gm_set_join_code(text, text),
  public.gm_approve_player_account(text),
  public.gm_reject_player_account(text),
  public.gm_check_login(text, text),
  public.gm_admin_list()
from public, anon, authenticated;

grant execute on function
  public.gm_register_player(text, text, text, text),
  public.gm_set_join_code(text, text),
  public.gm_approve_player_account(text),
  public.gm_reject_player_account(text),
  public.gm_check_login(text, text),
  public.gm_admin_list()
to service_role;

-- 10. accounts stays unreachable by the API
revoke all on table public.accounts from anon, authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
