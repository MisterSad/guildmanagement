-- Migration: normalize join codes to uppercase in both write and read paths.
-- Players may retype the code in lowercase (or an autocorrect does it for them),
-- producing a different SHA-256 hash and a false "invalid_code" error.

create or replace function public.gm_set_join_code(p_guild text, p_code text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_code is null or length(p_code) < 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into public.guild_config(guild, key, value, updated_at)
  values (
    p_guild,
    'join_code_hash',
    encode(extensions.digest(upper(p_code), 'sha256'), 'hex'),
    now()
  )
  on conflict (guild, key) do update
    set value = excluded.value, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

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

  -- Resolve guild from join code hash (code normalized to uppercase)
  select gc.guild into v_guild
  from public.guild_config gc
  where gc.key = 'join_code_hash'
    and gc.value = encode(extensions.digest(upper(p_join_code), 'sha256'), 'hex')
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

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
