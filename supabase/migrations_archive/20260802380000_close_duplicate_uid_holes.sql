-- Migration: close the two remaining duplicate-UID holes.
--
-- 1. prevent_duplicate_member_uid only rejected a NEW insert whose UID
--    exists in a DIFFERENT guild. A direct API call could still insert a
--    member with a UID already used in the SAME guild (the frontend guards
--    it, but the DB did not). Now any INSERT with an already-used UID is
--    rejected, regardless of guild. UPDATE stays exempt so transfers and
--    legacy duplicate rows remain movable.
--
-- 2. gm_transfer_guild_member checked duplicate pseudo in the target guild
--    but not duplicate UID: transferring a player to a guild that already
--    holds another member with the same UID (different pseudo) would have
--    created a same-guild UID duplicate. The transfer is now rejected with
--    'uid_already_in_target'.

create or replace function public.prevent_duplicate_member_uid()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $function$
declare
  v_new_uid text;
begin
  v_new_uid := coalesce(new.uid, '');
  if v_new_uid <> '' then
    -- Reject NEW inserts if the UID is already used anywhere (same guild or
    -- another guild). UPDATE is exempt: transfers move an existing row, and
    -- legacy duplicate rows must stay movable.
    if exists (
      select 1 from public.guild_members
      where uid = v_new_uid
        and id is distinct from new.id
    ) then
      raise exception 'uid_already_in_another_guild';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists prevent_duplicate_member_uid on public.guild_members;
create trigger prevent_duplicate_member_uid
  before insert on public.guild_members
  for each row
  execute function public.prevent_duplicate_member_uid();

-- Transfer: also reject when the target guild already holds this UID.
create or replace function public.gm_transfer_guild_member(
  p_uid text,
  p_target_guild text,
  p_pseudo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller_role text;
    v_caller_guild text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_uid text;
begin
    select role, guild into v_caller_role, v_caller_guild
    from public.accounts
    where auth_user_id = auth.uid()
       or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

    if v_caller_role is null then
        return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;

    if v_caller_role = 'super_admin' then
        if p_pseudo is not null and p_pseudo <> '' then
            select guild, pseudo, uid into v_source_guild, v_pseudo, v_uid
            from public.guild_members
            where uid = p_uid and lower(pseudo) = lower(p_pseudo)
            order by created_at desc
            limit 1;
        else
            select guild, pseudo, uid into v_source_guild, v_pseudo, v_uid
            from public.guild_members
            where uid = p_uid
            order by created_at desc
            limit 1;
        end if;
    else
        select guild, pseudo, uid into v_source_guild, v_pseudo, v_uid
        from public.guild_members
        where uid = p_uid
          and guild = coalesce(v_caller_guild, 'ALPHA');
    end if;

    if v_source_guild is null then
        return jsonb_build_object('ok', false, 'error', 'member_not_found');
    end if;

    if v_caller_role <> 'super_admin' and v_caller_guild <> v_source_guild then
        return jsonb_build_object('ok', false, 'error', 'permission_denied');
    end if;

    if v_caller_role <> 'super_admin' and not public.is_subscription_active(v_source_guild) then
        return jsonb_build_object('ok', false, 'error', 'subscription_expired');
    end if;

    if v_source_guild = p_target_guild then
        return jsonb_build_object('ok', false, 'error', 'same_guild');
    end if;

    select server_number into v_source_server from public.guilds where id = v_source_guild;
    select server_number into v_target_server from public.guilds where id = p_target_guild;

    if v_target_server is null then
        return jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    end if;

    if v_source_server is null or v_target_server is null or v_source_server <> v_target_server then
        return jsonb_build_object('ok', false, 'error', 'different_server');
    end if;

    -- Target guild must not already hold the same UID (under any pseudo)
    if exists (select 1 from public.guild_members where guild = p_target_guild and uid = p_uid) then
        return jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
    end if;

    if exists (select 1 from public.guild_members where guild = p_target_guild and lower(pseudo) = lower(v_pseudo)) then
        return jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    end if;

    update public.guild_members
    set guild = p_target_guild
    where uid = v_uid
      and pseudo = v_pseudo
      and guild = v_source_guild;

    update public.accounts
    set guild = p_target_guild
    where uid = v_uid
      and role = 'member';

    return jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
end;
$$;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
