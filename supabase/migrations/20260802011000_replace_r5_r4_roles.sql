-- 20260802011000_replace_r5_r4_roles.sql
-- Replace legacy numeric account roles (R5 / R4) with semantic roles:
--   R5 -> super_admin
--   R4 -> guild_admin
-- Plain member accounts keep the 'member' role.

BEGIN;

-- ── 1) Drop the legacy constraint first: it validates against 'R5'/'R4'
--    and would reject the role UPDATEs below. ─────────────────────────────
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS guild_admin_must_have_guild;

-- ── 2) Migrate existing account rows ───────────────────────────────────────
UPDATE public.accounts SET role = 'super_admin' WHERE role = 'R5';
UPDATE public.accounts SET role = 'guild_admin' WHERE role = 'R4';

-- ── 3) Refresh app_metadata on existing auth.users so that refreshed /
--    re-issued JWTs carry the new role values (existing access tokens
--    keep their old claims until the next refresh or re-login). ───────────
UPDATE auth.users
SET raw_app_meta_data = jsonb_set(
        COALESCE(raw_app_meta_data, '{}'::jsonb),
        '{app_role}',
        to_jsonb(
            CASE raw_app_meta_data ->> 'app_role'
                WHEN 'R5' THEN 'super_admin'
                WHEN 'R4' THEN 'guild_admin'
                ELSE COALESCE(raw_app_meta_data ->> 'app_role', 'member')
            END
        )
    )
WHERE raw_app_meta_data ->> 'app_role' IN ('R5', 'R4');

-- ── 4) Recreate SECURITY DEFINER functions with semantic roles ──────────────

CREATE OR REPLACE FUNCTION public.check_user_guild_access(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_guild text;
  v_effective_guild text;
BEGIN
  -- Fetch caller role and guild from accounts table
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Unauthenticated callers have no access
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Super Admin can access all guilds
  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  v_effective_guild := COALESCE(p_guild, 'ALPHA');
  RETURN v_guild = v_effective_guild OR v_guild IS NULL OR v_guild = 'ALL';
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_user_guild_read_access(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_guild text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_role IS NULL THEN
    IF auth.role() = 'authenticated' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_guild, 'ALPHA') = p_guild;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_user_guild_write_access(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_guild text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_role IS NULL THEN
    IF auth.role() = 'authenticated' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_guild, 'ALPHA') = p_guild;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
 RETURNS TABLE(canonical_id text, role text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT a.id, COALESCE(a.role, 'guild_admin')
  FROM public.accounts a
  WHERE LOWER(a.id) = LOWER(p_id)
    AND a.password_enc IS NOT NULL
    AND extensions.pgp_sym_decrypt(
          a.password_enc,
          (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
        ) = p_password
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
BEGIN
  -- Super Admin is never restricted by subscription expiration
  SELECT role INTO v_role
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  RETURN COALESCE(
    (SELECT
       CASE
         WHEN subscription_type = 'Unlimited' THEN true
         WHEN subscription_type = 'Premium' AND subscription_end >= now() THEN true
         ELSE false
       END
     FROM public.guilds
     WHERE id = p_guild),
    true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE auth_user_id = auth.uid()
      AND role = 'super_admin'
  );
$function$;

CREATE OR REPLACE FUNCTION public.gm_admin_list()
 RETURNS TABLE(id text, role text, guild text, auth_user_id uuid, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    a.id,
    coalesce(a.role, 'guild_admin'),
    a.guild,
    a.auth_user_id,
    a.created_at
  FROM public.accounts a
  ORDER BY a.id;
$function$;

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(p_id text, p_password text, p_role text, p_guild text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.accounts(id, role, password_enc, guild, created_at)
  VALUES (
    p_id,
    COALESCE(NULLIF(p_role, ''), 'guild_admin'),
    extensions.pgp_sym_encrypt(p_password, (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
    p_guild,
    NOW())
  ON CONFLICT (id) DO UPDATE
    SET role         = COALESCE(NULLIF(p_role, ''), 'guild_admin'),
        password_enc = extensions.pgp_sym_encrypt(p_password, (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
        guild        = p_guild;
END $function$;

CREATE OR REPLACE FUNCTION public.list_event_sessions(p_guild text DEFAULT NULL::text)
 RETURNS TABLE(event_name text, session_id text, week_start date, participants integer, participated_count integer, total_score bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
BEGIN
    -- Fetch account info
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    -- Resolve target guild safely (fallback to p_guild or ALPHA if accounts row not linked)
    IF v_user_role = 'guild_admin' THEN
        v_target_guild := COALESCE(v_user_guild, 'ALPHA');
    ELSE
        v_target_guild := COALESCE(p_guild, COALESCE(v_user_guild, 'ALPHA'));
    END IF;

    RETURN QUERY
    SELECT
        ep.event_name,
        ep.session_id,
        ep.week_start,
        COUNT(*)::integer AS participants,
        SUM(CASE WHEN ep.participated > 0 THEN 1 ELSE 0 END)::integer AS participated_count,
        SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0))::bigint AS total_score
    FROM public.event_participants ep
    WHERE ep.guild = v_target_guild
    GROUP BY ep.event_name, ep.session_id, ep.week_start
    ORDER BY COALESCE(ep.session_id, ep.week_start::text || 'T00:00:00.000Z') DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_event_weeks(p_guild text DEFAULT NULL::text)
 RETURNS TABLE(week_start date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
BEGIN
    SELECT role, guild INTO v_user_role, v_user_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_user_role = 'guild_admin' THEN
        v_target_guild := COALESCE(v_user_guild, 'ALPHA');
    ELSE
        v_target_guild := COALESCE(p_guild, COALESCE(v_user_guild, 'ALPHA'));
    END IF;

    RETURN QUERY
    SELECT DISTINCT ep.week_start
    FROM public.event_participants ep
    WHERE ep.week_start IS NOT NULL
      AND ep.guild = v_target_guild
    ORDER BY ep.week_start DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_transfer public.guild_transfers%ROWTYPE;
BEGIN
    -- Get caller info
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Get transfer record
    SELECT * INTO v_transfer FROM public.guild_transfers WHERE id = p_transfer_id AND status = 'pending';

    IF v_transfer.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    END IF;

    -- Check caller permission: super_admin can resolve any, guild_admin can resolve only if they are the target guild
    IF v_caller_role <> 'super_admin' AND v_caller_guild <> v_transfer.target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF p_action = 'approve' THEN
        -- Check if target guild already has a member with the same pseudo (to prevent unique constraint error)
        IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_transfer.target_guild AND LOWER(pseudo) = LOWER(v_transfer.pseudo)) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
        END IF;

        -- Update guild_members
        UPDATE public.guild_members
        SET guild = v_transfer.target_guild
        WHERE uid = v_transfer.uid;

        -- Update transfer status
        UPDATE public.guild_transfers
        SET status = 'approved',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'approved');

    ELSIF p_action = 'reject' THEN
        -- Update transfer status
        UPDATE public.guild_transfers
        SET status = 'rejected',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'rejected');
    ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_guild_member(p_uid text, p_target_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
BEGIN
    -- Get caller info
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid();

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Find the member
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    -- Check caller permission: super_admin can transfer any, guild_admin can transfer only from their assigned guild
    IF v_caller_role <> 'super_admin' AND v_caller_guild <> v_source_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    -- Check subscription is active for guild_admin callers
    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_source_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    -- Cannot transfer to the exact same guild
    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    -- Fetch server numbers for source and target guilds
    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    -- Validate target guild exists and is on the SAME server
    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    -- Check if target guild already has a member with the same pseudo
    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND LOWER(pseudo) = LOWER(v_pseudo)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    END IF;

    -- Perform the transfer on guild_members table
    UPDATE public.guild_members
    SET guild = p_target_guild
    WHERE uid = p_uid;

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$function$;

-- ── 5) Recreate RLS policies that referenced 'R5' ───────────────────────────

DROP POLICY IF EXISTS "Super admins can update accounts" ON public.accounts;
CREATE POLICY "Super admins can update accounts" ON public.accounts
  FOR UPDATE TO authenticated
  USING (((auth.jwt() -> 'app_metadata'::text) ->> 'app_role'::text) = 'super_admin'::text)
  WITH CHECK (((auth.jwt() -> 'app_metadata'::text) ->> 'app_role'::text) = 'super_admin'::text);

DROP POLICY IF EXISTS "Users can select their own account" ON public.accounts;
CREATE POLICY "Users can select their own account" ON public.accounts
  FOR SELECT TO authenticated
  USING (((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'account_id'::text)) = id)
      OR (((auth.jwt() -> 'app_metadata'::text) ->> 'app_role'::text) = 'super_admin'::text)));

DROP POLICY IF EXISTS "Super admins can manage guilds" ON public.guilds;
CREATE POLICY "Super admins can manage guilds" ON public.guilds
  FOR ALL TO authenticated
  USING (((auth.jwt() -> 'app_metadata'::text) ->> 'app_role'::text) = 'super_admin'::text)
  WITH CHECK (((auth.jwt() -> 'app_metadata'::text) ->> 'app_role'::text) = 'super_admin'::text);

DROP POLICY IF EXISTS "Admins can view their guild transfers" ON public.guild_transfers;
CREATE POLICY "Admins can view their guild transfers" ON public.guild_transfers
  FOR SELECT TO authenticated
  USING ((
    source_guild = (SELECT accounts.guild FROM public.accounts WHERE accounts.auth_user_id = auth.uid())
    OR target_guild = (SELECT accounts.guild FROM public.accounts WHERE accounts.auth_user_id = auth.uid())
    OR (SELECT accounts.role FROM public.accounts WHERE accounts.auth_user_id = auth.uid()) = 'super_admin'::text
  ));

DROP POLICY IF EXISTS "Target admins can update transfers" ON public.guild_transfers;
CREATE POLICY "Target admins can update transfers" ON public.guild_transfers
  FOR UPDATE TO authenticated
  USING ((
    target_guild = (SELECT accounts.guild FROM public.accounts WHERE accounts.auth_user_id = auth.uid())
    OR (SELECT accounts.role FROM public.accounts WHERE accounts.auth_user_id = auth.uid()) = 'super_admin'::text
  ));

-- ── 6) Enforce the semantic role vocabulary ─────────────────────────────────
-- Replace the legacy constraint (role = 'R5' OR (role = 'R4' AND guild NOT NULL)):
-- a guild_admin account must always be attached to a guild, super_admin and
-- member accounts are not restricted.
ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS guild_admin_must_have_guild;

ALTER TABLE public.accounts
  ADD CONSTRAINT guild_admin_must_have_guild CHECK (
    role IN ('super_admin', 'member')
    OR (role = 'guild_admin' AND guild IS NOT NULL AND guild <> '')
  );

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_role_check CHECK (role IN ('super_admin', 'guild_admin', 'member'));

COMMIT;
