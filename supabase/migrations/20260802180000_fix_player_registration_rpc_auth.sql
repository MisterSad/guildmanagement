-- Migration: fix player-registration RPCs (caller checks belong in the edge
-- functions, not in the SQL: edge functions call with service_role where
-- auth.uid() is null, so auth.uid()-based guards always returned 'unauthorized'.

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
    encode(extensions.digest(p_code, 'sha256'), 'hex'),
    now()
  )
  on conflict (guild, key) do update
    set value = excluded.value, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.gm_approve_player_account(p_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_target_guild text;
  v_target_status text;
begin
  select guild, status into v_target_guild, v_target_status
  from public.accounts where id = p_id;

  if v_target_guild is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_target_status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  update public.accounts set status = 'active' where id = p_id;

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.gm_reject_player_account(p_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_target_guild text;
  v_target_status text;
begin
  select guild, status into v_target_guild, v_target_status
  from public.accounts where id = p_id;

  if v_target_guild is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_target_status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  delete from public.accounts where id = p_id;

  return jsonb_build_object('ok', true);
end;
$function$;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
