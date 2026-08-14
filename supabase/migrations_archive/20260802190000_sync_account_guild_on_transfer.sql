-- Migration: keep player accounts in sync when a member transfers guilds.
-- Both transfer paths (admin direct: transfer_guild_member, and portal request
-- resolved by admin: resolve_guild_transfer) moved guild_members.guild but left
-- accounts.guild pointing at the old guild. Consequences fixed here:
--   - a logged-in player account would keep RLS access to the OLD guild
--     (check_user_guild_access reads accounts.guild) and lose the new one
--   - a pending account could not be approved by the new guild's admin
-- Only 'member' accounts are re-bound (admins have no in-game UID bound).

create or replace function public.transfer_guild_member(p_uid text, p_target_guild text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_caller_role text;
    v_caller_guild text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
begin
    -- Get caller info
    select role, guild into v_caller_role, v_caller_guild
    from public.accounts
    where auth_user_id = auth.uid();

    if v_caller_role is null then
        return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;

    -- Find the member
    select guild, pseudo into v_source_guild, v_pseudo
    from public.guild_members
    where uid = p_uid;

    if v_source_guild is null then
        return jsonb_build_object('ok', false, 'error', 'member_not_found');
    end if;

    -- Check caller permission: super_admin can transfer any, guild_admin can transfer only from their assigned guild
    if v_caller_role <> 'super_admin' and v_caller_guild <> v_source_guild then
        return jsonb_build_object('ok', false, 'error', 'permission_denied');
    end if;

    -- Check subscription is active for guild_admin callers
    if v_caller_role <> 'super_admin' and not public.is_subscription_active(v_source_guild) then
        return jsonb_build_object('ok', false, 'error', 'subscription_expired');
    end if;

    -- Cannot transfer to the exact same guild
    if v_source_guild = p_target_guild then
        return jsonb_build_object('ok', false, 'error', 'same_guild');
    end if;

    -- Fetch server numbers for source and target guilds
    select server_number into v_source_server from public.guilds where id = v_source_guild;
    select server_number into v_target_server from public.guilds where id = p_target_guild;

    -- Validate target guild exists and is on the SAME server
    if v_target_server is null then
        return jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    end if;

    if v_source_server is null or v_target_server is null or v_source_server <> v_target_server then
        return jsonb_build_object('ok', false, 'error', 'different_server');
    end if;

    -- Check if target guild already has a member with the same pseudo
    if exists (select 1 from public.guild_members where guild = p_target_guild and lower(pseudo) = lower(v_pseudo)) then
        return jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    end if;

    -- Perform the transfer on guild_members table
    update public.guild_members
    set guild = p_target_guild
    where uid = p_uid;

    -- Keep the bound player account in sync with the new guild
    update public.accounts
    set guild = p_target_guild
    where uid = p_uid
      and role = 'member';

    return jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
end;
$function$;

create or replace function public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_caller_role text;
    v_caller_guild text;
    v_transfer public.guild_transfers%ROWTYPE;
begin
    -- Get caller info
    select role, guild into v_caller_role, v_caller_guild
    from public.accounts
    where auth_user_id = auth.uid();

    if v_caller_role is null then
        return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;

    -- Get transfer record
    select * into v_transfer from public.guild_transfers where id = p_transfer_id and status = 'pending';

    if v_transfer.id is null then
        return jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    end if;

    -- Check caller permission: super_admin can resolve any, guild_admin can resolve only if they are the target guild
    if v_caller_role <> 'super_admin' and v_caller_guild <> v_transfer.target_guild then
        return jsonb_build_object('ok', false, 'error', 'permission_denied');
    end if;

    if p_action = 'approve' then
        -- Check if target guild already has a member with the same pseudo (to prevent unique constraint error)
        if exists (select 1 from public.guild_members where guild = v_transfer.target_guild and lower(pseudo) = lower(v_transfer.pseudo)) then
            return jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
        end if;

        -- Update guild_members
        update public.guild_members
        set guild = v_transfer.target_guild
        where uid = v_transfer.uid;

        -- Keep the bound player account in sync with the new guild
        update public.accounts
        set guild = v_transfer.target_guild
        where uid = v_transfer.uid
          and role = 'member';

        -- Update transfer status
        update public.guild_transfers
        set status = 'approved',
            resolved_at = now(),
            resolved_by = auth.uid()
        where id = p_transfer_id;

        return jsonb_build_object('ok', true, 'status', 'approved');

    elsif p_action = 'reject' then
        -- Update transfer status
        update public.guild_transfers
        set status = 'rejected',
            resolved_at = now(),
            resolved_by = auth.uid()
        where id = p_transfer_id;

        return jsonb_build_object('ok', true, 'status', 'rejected');
    else
        return jsonb_build_object('ok', false, 'error', 'invalid_action');
    end if;
end;
$function$;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
