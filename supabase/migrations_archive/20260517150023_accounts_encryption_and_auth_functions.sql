-- 1. Reversible encryption key in Vault (idempotent)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'gm_accounts_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'gm_accounts_key',
      'Reversible encryption key for accounts passwords (guild management)'
    );
  end if;
end $$;

-- 2. New columns: encrypted human password, shadow auth user, encrypted shadow secret
alter table public.accounts
  add column if not exists password_enc       bytea,
  add column if not exists auth_user_id       uuid,
  add column if not exists gotrue_secret_enc  bytea;

-- 3. Backfill encrypted passwords from existing plaintext (plaintext kept until validated)
update public.accounts
set password_enc = extensions.pgp_sym_encrypt(
      password,
      (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'))
where password_enc is null and password is not null;

-- 4. Locked-down SECURITY DEFINER functions (service_role only; bypass RLS as definer)
create or replace function public.gm_check_login(p_id text, p_password text)
returns text language sql security definer set search_path = '' as $$
  select a.role
  from public.accounts a
  where a.id = p_id
    and a.password_enc is not null
    and extensions.pgp_sym_decrypt(
          a.password_enc,
          (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')
        ) = p_password
  limit 1;
$$;

create or replace function public.gm_get_shadow(p_id text)
returns table(auth_user_id uuid, gotrue_secret text)
language sql security definer set search_path = '' as $$
  select a.auth_user_id,
         case when a.gotrue_secret_enc is null then null
              else extensions.pgp_sym_decrypt(
                     a.gotrue_secret_enc,
                     (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'))
         end
  from public.accounts a
  where a.id = p_id;
$$;

create or replace function public.gm_attach_shadow(p_id text, p_auth_user_id uuid, p_secret text)
returns void language sql security definer set search_path = '' as $$
  update public.accounts
  set auth_user_id      = p_auth_user_id,
      gotrue_secret_enc = extensions.pgp_sym_encrypt(
        p_secret,
        (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key'))
  where id = p_id;
$$;

create or replace function public.gm_admin_list()
returns table(id text, role text, password text, created_at timestamptz)
language sql security definer set search_path = '' as $$
  select a.id,
         coalesce(a.role, 'R4'),
         extensions.pgp_sym_decrypt(
           a.password_enc,
           (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'gm_accounts_key')),
         a.created_at
  from public.accounts a
  order by a.id;
$$;

create or replace function public.gm_admin_upsert(p_id text, p_password text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
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
end $$;

create or replace function public.gm_admin_delete(p_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uuid uuid;
begin
  select auth_user_id into v_uuid from public.accounts where id = p_id;
  delete from public.accounts where id = p_id;
  return v_uuid;
end $$;

-- 5. Lock down execution: only service_role (used inside Edge Functions) may call these
revoke all on function
  public.gm_check_login(text, text),
  public.gm_get_shadow(text),
  public.gm_attach_shadow(text, uuid, text),
  public.gm_admin_list(),
  public.gm_admin_upsert(text, text, text),
  public.gm_admin_delete(text)
from public, anon, authenticated;

grant execute on function
  public.gm_check_login(text, text),
  public.gm_get_shadow(text),
  public.gm_attach_shadow(text, uuid, text),
  public.gm_admin_list(),
  public.gm_admin_upsert(text, text, text),
  public.gm_admin_delete(text)
to service_role;

-- 6. Make the accounts table explicitly unreachable by the public/anon/authenticated API
revoke all on table public.accounts from anon, authenticated;;
