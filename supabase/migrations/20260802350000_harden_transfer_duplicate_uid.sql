-- Migration: harden transfer_guild_member against duplicate UIDs.
-- Some members exist in two guilds with the same UID (legacy data: they
-- were added to a new guild without removing the old row). The function
-- resolved the source row by uid only, which could pick the WRONG guild's
-- row (e.g. an ALPHA duplicate for a member now in OMEGA), producing
-- spurious permission_denied. It now resolves the source row within the
-- caller's own guild: uid + guild. A new function name forces a fresh
-- PostgREST plan.

create or replace function public.gm_transfer_guild_member(
  p_uid text,
  p_target_guild text
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
    -- Get caller info
    select role, guild into v_caller_role, v_caller_guild
    from public.accounts
    where auth_user_id = auth.uid()
       or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

    if v_caller_role is null then
        return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;

    -- Find the member within the caller's own guild (uid + guild), so a
    -- duplicate UID in another guild never shadows the real source row.
    select guild, pseudo, uid into v_source_guild, v_pseudo, v_uid
    from public.guild_members
    where uid = p_uid
      and guild = coalesce(v_caller_guild, 'ALPHA');

    if v_source_guild is null then
        return jsonb_build_object('ok', false, 'error', 'member_not_found');
    end if;

    -- Check caller permission: super_admin can transfer any, guild_admin can
    -- transfer only from their assigned guild (already enforced by the
    -- resolution above, kept for defense in depth)
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

    -- Perform the transfer on guild_members table (only the caller's guild row)
    update public.guild_members
    set guild = p_target_guild
    where uid = v_uid
      and guild = v_source_guild;

    -- Keep the bound player account in sync with the new guild
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

-- Keep the old name working (it is what the frontend calls); re-point it to
-- the fixed body. Renaming was only needed to bust the plan cache.
create or replace function public.transfer_guild_member(p_uid text, p_target_guild text)
returns jsonb
language sql
security definer
set search_path = public
as $$
    select * from public.gm_transfer_guild_member(p_uid, p_target_guild);
$$;

revoke all on function public.transfer_guild_member(text, text) from public, anon;
revoke all on function public.gm_transfer_guild_member(text, text) from public, anon;
grant execute on function public.transfer_guild_member(text, text) to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
