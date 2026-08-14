-- 20260807010000_admin_uid_lookup_and_transfer_request.sql
-- Admin tooling for duplicate-UID handling on member add.
--
--   1. gm_find_player_by_uid(p_uid): returns where a UID currently lives
--      (pseudo, uid, guild, server number, role, power, created_at) plus the
--      player's name-change history. Admin-only (super_admin / guild_admin);
--      member accounts get 'forbidden'. Used by the add-member dialog to show
--      the player's current location before offering a transfer request.
--
--   2. gm_admin_request_transfer(p_uid, p_target_guild): creates a pending
--      guild_transfers row from the player's current guild into the caller's
--      guild (a guild_admin's target is forced to their own guild; super_admin
--      must pass an explicit target). Same-server validation, duplicate and
--      subscription checks. The request then shows up in the target guild's
--      "Pending Transfers" list for approval.
--
--   3. RLS hardening on guild_transfers: the legacy inline-accounts policies
--      targeted all `authenticated` and could let a member whose accounts.guild
--      matched read transfers and even resolve them. Replaced with helper-based
--      admin-only policies (gm_can_read_guild_data / check_user_guild_write_access).
--
--   4. resolve_guild_transfer hardened: approval now scopes the guild_members
--      UPDATE to the transfer's source guild (legacy duplicate UIDs would drag
--      unrelated rows), rejects stale approvals and target duplicates, enforces
--      the subscription gate and uses search_path ''.
--
--   5. check_uid_exists_globally re-granted to authenticated (it was revoked
--      for anon/public in an earlier migration but the add-member flow needs it).
--
-- All functions are SECURITY DEFINER with search_path '' and public. tables.

BEGIN;

-- ── 1. Lookup where a UID currently lives (admin-only) ──────────────────────
create or replace function public.gm_find_player_by_uid(p_uid text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
  v_player record;
  v_server integer;
  v_history jsonb;
begin
  select role into v_role
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null or v_role = 'member' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select pseudo, uid, guild, role, overall_power, created_at into v_player
  from public.guild_members
  where uid = p_uid
  order by created_at desc
  limit 1;

  if v_player.uid is null then
    return jsonb_build_object('ok', true, 'found', false);
  end if;

  select server_number into v_server
  from public.guilds
  where id = v_player.guild;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'old_pseudo', h.old_pseudo,
      'new_pseudo', h.new_pseudo,
      'changed_at', h.changed_at,
      'changed_by', h.changed_by
    ) order by h.changed_at desc
  ), '[]'::jsonb) into v_history
  from public.player_name_history h
  where h.uid = p_uid;

  return jsonb_build_object(
    'ok', true,
    'found', true,
    'player', jsonb_build_object(
      'pseudo', v_player.pseudo,
      'uid', v_player.uid,
      'guild', v_player.guild,
      'server_number', v_server,
      'role', v_player.role,
      'overall_power', v_player.overall_power,
      'created_at', v_player.created_at
    ),
    'name_history', v_history
  );
end;
$function$;

-- ── 2. Admin-initiated transfer request (pending approval) ───────────────────
create or replace function public.gm_admin_request_transfer(p_uid text, p_target_guild text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
  v_caller_guild text;
  v_target text;
  v_source_guild text;
  v_source_server integer;
  v_target_server integer;
  v_pseudo text;
  v_new_id uuid;
begin
  select role, guild into v_role, v_caller_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null or v_role = 'member' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- guild_admin can only request into their own guild; super_admin must pass
  -- an explicit target (they are not bound to one guild).
  if v_role = 'super_admin' then
    if p_target_guild is null or p_target_guild = '' then
      return jsonb_build_object('ok', false, 'error', 'missing_target_guild');
    end if;
    v_target := upper(p_target_guild);
  else
    v_target := coalesce(v_caller_guild, 'ALPHA');
  end if;

  -- Subscription gate: expired guilds cannot request transfers.
  if v_role <> 'super_admin' and not public.is_subscription_active(v_target) then
    return jsonb_build_object('ok', false, 'error', 'subscription_expired');
  end if;

  -- Find the player's current guild.
  select guild, pseudo into v_source_guild, v_pseudo
  from public.guild_members
  where uid = p_uid
  order by created_at desc
  limit 1;

  if v_source_guild is null then
    return jsonb_build_object('ok', false, 'error', 'member_not_found');
  end if;

  if v_source_guild = v_target then
    return jsonb_build_object('ok', false, 'error', 'same_guild');
  end if;

  -- Target guild must already hold this UID.
  if exists (select 1 from public.guild_members where guild = v_target and uid = p_uid) then
    return jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
  end if;

  -- Same-server requirement (transfers are server-scoped).
  select server_number into v_source_server from public.guilds where id = v_source_guild;
  select server_number into v_target_server from public.guilds where id = v_target;

  if v_target_server is null then
    return jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
  end if;
  if v_source_server is null or v_target_server is null or v_source_server <> v_target_server then
    return jsonb_build_object('ok', false, 'error', 'different_server');
  end if;

  -- One pending request per player at a time.
  if exists (
    select 1 from public.guild_transfers
    where uid = p_uid and status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_pending');
  end if;

  insert into public.guild_transfers (uid, pseudo, source_guild, target_guild, status)
  values (p_uid, v_pseudo, v_source_guild, v_target, 'pending')
  returning id into v_new_id;

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_new_id,
    'source_guild', v_source_guild,
    'target_guild', v_target
  );
end;
$function$;

-- ── 3. RLS hardening on guild_transfers (admin-only, helper-based) ──────────
drop policy if exists "Admins can view their guild transfers" on public.guild_transfers;
drop policy if exists "Target admins can update transfers" on public.guild_transfers;

create policy gm_authenticated_select on public.guild_transfers
  for select to authenticated
  using (
    public.gm_can_read_guild_data(source_guild)
    or public.gm_can_read_guild_data(target_guild)
  );

create policy gm_authenticated_update on public.guild_transfers
  for update to authenticated
  using (
    public.check_user_guild_write_access(target_guild)
    and public.is_subscription_active(target_guild)
  )
  with check (
    public.check_user_guild_write_access(target_guild)
    and public.is_subscription_active(target_guild)
  );

-- ── 4. Harden resolve_guild_transfer (stale / duplicate-safe approval) ───────
create or replace function public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
    v_caller_role text;
    v_caller_guild text;
    v_transfer public.guild_transfers%ROWTYPE;
begin
    select role, guild into v_caller_role, v_caller_guild
    from public.accounts
    where auth_user_id = auth.uid();

    if v_caller_role is null then
        return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;

    select * into v_transfer from public.guild_transfers
    where id = p_transfer_id and status = 'pending';

    if v_transfer.id is null then
        return jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    end if;

    -- super_admin can resolve any; guild_admin only transfers INTO their guild.
    if v_caller_role <> 'super_admin' and v_caller_guild <> v_transfer.target_guild then
        return jsonb_build_object('ok', false, 'error', 'permission_denied');
    end if;

    -- Subscription gate on the target guild.
    if v_caller_role <> 'super_admin' and not public.is_subscription_active(v_transfer.target_guild) then
        return jsonb_build_object('ok', false, 'error', 'subscription_expired');
    end if;

    if p_action = 'approve' then
        -- The player must still live in the source guild (stale approval check).
        if not exists (
            select 1 from public.guild_members
            where uid = v_transfer.uid and guild = v_transfer.source_guild
        ) then
            return jsonb_build_object('ok', false, 'error', 'member_no_longer_in_source');
        end if;

        -- Target must not already hold the same UID or pseudo.
        if exists (select 1 from public.guild_members where guild = v_transfer.target_guild and uid = v_transfer.uid) then
            return jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
        end if;
        if exists (select 1 from public.guild_members where guild = v_transfer.target_guild and lower(pseudo) = lower(v_transfer.pseudo)) then
            return jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
        end if;

        -- Move only the source-guild row for this UID (legacy duplicate UIDs
        -- must not drag unrelated guild rows into the target).
        update public.guild_members
        set guild = v_transfer.target_guild
        where uid = v_transfer.uid
          and guild = v_transfer.source_guild;

        -- Keep the bound player account in sync with the new guild.
        update public.accounts
        set guild = v_transfer.target_guild
        where uid = v_transfer.uid
          and role = 'member';

        update public.guild_transfers
        set status = 'approved',
            resolved_at = now(),
            resolved_by = auth.uid()
        where id = p_transfer_id;

        return jsonb_build_object('ok', true, 'status', 'approved');

    elsif p_action = 'reject' then
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

-- ── 5. Re-grant the add-member UID probe (revoked for anon/public earlier) ──
grant execute on function public.check_uid_exists_globally(text) to authenticated;

-- ── Grants (role-gated inside, no anon/public exposure) ─────────────────────
revoke all on function public.gm_find_player_by_uid(text)
  from public, anon, authenticated;
grant execute on function public.gm_find_player_by_uid(text)
  to authenticated;

revoke all on function public.gm_admin_request_transfer(text, text)
  from public, anon, authenticated;
grant execute on function public.gm_admin_request_transfer(text, text)
  to authenticated;

revoke all on function public.resolve_guild_transfer(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_guild_transfer(uuid, text)
  to authenticated;

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
