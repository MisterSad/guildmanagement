-- Migration: fix gm_transfer_guild_member resolution for super admins and
-- add pseudo disambiguation for duplicate UIDs.
--   - guild_admin: source row resolved within their own guild (uid + guild)
--   - super_admin: source row resolved by uid + optional pseudo; without a
--     pseudo and with duplicate UIDs, the MOST RECENT row is used.
-- The wrapper transfer_guild_member gains an optional p_pseudo parameter.

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

    -- Resolve the source row.
    if v_caller_role = 'super_admin' then
        -- Super admin: uid, optionally disambiguated by pseudo; else most recent.
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
        -- guild_admin: within their own guild (duplicates elsewhere can't shadow)
        select guild, pseudo, uid into v_source_guild, v_pseudo, v_uid
        from public.guild_members
        where uid = p_uid
          and guild = coalesce(v_caller_guild, 'ALPHA');
    end if;

    if v_source_guild is null then
        return jsonb_build_object('ok', false, 'error', 'member_not_found');
    end if;

    -- Check caller permission: guild_admin can transfer only from their guild
    -- (already enforced by resolution, kept for defense in depth)
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

create or replace function public.transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text default null)
returns jsonb
language sql
security definer
set search_path = public
as $$
    select * from public.gm_transfer_guild_member(p_uid, p_target_guild, p_pseudo);
$$;

revoke all on function public.transfer_guild_member(text, text) from public, anon;
revoke all on function public.transfer_guild_member(text, text, text) from public, anon;
revoke all on function public.gm_transfer_guild_member(text, text, text) from public, anon;
grant execute on function public.transfer_guild_member(text, text, text) to authenticated;
grant execute on function public.transfer_guild_member(text, text) to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
