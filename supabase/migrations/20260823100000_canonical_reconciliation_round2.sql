-- 20260823100000_canonical_reconciliation_round2.sql
-- Workstream GAP 1: Canonical Migration Reconciliation (Round 2)
-- Ports 13 archive-only RPCs to canonical migrations, adds partial unique indexes,
-- adds case-insensitive account ID index, accounts authenticated SELECT grant, and event_status unique constraint.

-- ============================================================================
-- 1. INDEXES AND TABLE CONSTRAINTS
-- ============================================================================

-- 1.a Partial unique indexes on event_participants
CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_tenant_session_unique
    ON public.event_participants (guild, event_name, session_id, pseudo)
    WHERE session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_tenant_no_session_unique
    ON public.event_participants (guild, event_name, week_start, pseudo)
    WHERE session_id IS NULL;

-- 1.b Case-insensitive unique index on accounts.id
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_lower_id
    ON public.accounts (LOWER(id));

-- 1.c Unique index on event_status for ON CONFLICT (guild, event_name) support
CREATE UNIQUE INDEX IF NOT EXISTS event_status_guild_event_key
    ON public.event_status (guild, event_name);

-- 1.d Grant SELECT on accounts to authenticated (required by player_push_prefs RLS subqueries)
GRANT SELECT ON public.accounts TO authenticated;

-- ============================================================================
-- 2. PORTED CANONICAL RPCS (Hardened to Round-1/Postgres 17 Standards)
-- ============================================================================

-- 2.1 gm_register_player
CREATE OR REPLACE FUNCTION public.gm_register_player(
    p_id text,
    p_password text,
    p_uid text,
    p_join_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_guild text;
  v_uid_ok boolean;
  v_uid_taken boolean;
  v_id_taken boolean;
  v_key text;
BEGIN
  IF p_id IS NULL OR length(p_id) < 3 OR length(p_id) > 32 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_identifier');
  END IF;
  IF p_password IS NULL OR length(p_password) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'weak_password');
  END IF;
  IF p_uid IS NULL OR p_uid !~ '^[0-9]{1,20}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_uid');
  END IF;

  SELECT gc.guild INTO v_guild
  FROM public.guild_config gc
  WHERE gc.key = 'join_code_hash'
    AND gc.value = encode(extensions.digest(upper(trim(p_join_code)), 'sha256'), 'hex')
  LIMIT 1;

  IF v_guild IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  SELECT exists(
    SELECT 1 FROM public.guild_members gm
    WHERE gm.guild = v_guild AND gm.uid = p_uid
  ) INTO v_uid_ok;

  IF NOT v_uid_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'uid_not_in_guild');
  END IF;

  SELECT exists(
    SELECT 1 FROM public.accounts a WHERE a.uid = p_uid
  ) INTO v_uid_taken;

  IF v_uid_taken THEN
    RETURN jsonb_build_object('ok', false, 'error', 'uid_already_claimed');
  END IF;

  SELECT exists(
    SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(trim(p_id))
  ) INTO v_id_taken;

  IF v_id_taken THEN
    RETURN jsonb_build_object('ok', false, 'error', 'identifier_taken');
  END IF;

  SELECT s.decrypted_secret INTO v_key
  FROM vault.decrypted_secrets s
  WHERE s.name = 'gm_accounts_key';

  INSERT INTO public.accounts(id, role, password_enc, password_hash, guild, uid, status, created_at)
  VALUES (
    trim(p_id),
    'member',
    CASE WHEN v_key IS NOT NULL THEN extensions.pgp_sym_encrypt(p_password, v_key) ELSE NULL END,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
    v_guild,
    p_uid,
    'pending',
    now()
  );

  RETURN jsonb_build_object('ok', true, 'status', 'pending');
END;
$$;

-- 2.2 gm_set_join_code
CREATE OR REPLACE FUNCTION public.gm_set_join_code(p_guild text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_code IS NULL OR length(trim(p_code)) < 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;

  INSERT INTO public.guild_config(guild, key, value, updated_at)
  VALUES (
    p_guild,
    'join_code_plain',
    upper(trim(p_code)),
    now()
  )
  ON CONFLICT (guild, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.guild_config(guild, key, value, updated_at)
  VALUES (
    p_guild,
    'join_code_hash',
    encode(extensions.digest(upper(trim(p_code)), 'sha256'), 'hex'),
    now()
  )
  ON CONFLICT (guild, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2.3 gm_get_join_code
CREATE OR REPLACE FUNCTION public.gm_get_join_code(p_guild text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_code text;
BEGIN
  SELECT value INTO v_code
  FROM public.guild_config
  WHERE guild = p_guild AND key = 'join_code_plain';

  RETURN jsonb_build_object('ok', true, 'code', v_code);
END;
$$;

-- 2.4 gm_approve_player_account
CREATE OR REPLACE FUNCTION public.gm_approve_player_account(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_target_guild text;
  v_target_status text;
BEGIN
  SELECT guild, status INTO v_target_guild, v_target_status
  FROM public.accounts WHERE lower(id) = lower(trim(p_id));

  IF v_target_guild IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_target_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
  END IF;

  UPDATE public.accounts
  SET status = 'active'
  WHERE lower(id) = lower(trim(p_id));

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2.5 gm_reject_player_account
CREATE OR REPLACE FUNCTION public.gm_reject_player_account(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_target_guild text;
  v_target_status text;
BEGIN
  SELECT guild, status INTO v_target_guild, v_target_status
  FROM public.accounts WHERE lower(id) = lower(trim(p_id));

  IF v_target_guild IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_target_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
  END IF;

  DELETE FROM public.accounts WHERE lower(id) = lower(trim(p_id));

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2.6 gm_get_shadow
CREATE OR REPLACE FUNCTION public.gm_get_shadow(p_id text)
RETURNS TABLE(auth_user_id uuid, gotrue_secret text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT a.auth_user_id,
         CASE WHEN a.gotrue_secret_enc IS NULL THEN NULL
              ELSE extensions.pgp_sym_decrypt(
                     a.gotrue_secret_enc,
                     (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
                   )
         END
  FROM public.accounts a
  WHERE lower(a.id) = lower(trim(p_id))
  LIMIT 1;
$$;

-- 2.7 gm_attach_shadow
CREATE OR REPLACE FUNCTION public.gm_attach_shadow(p_id text, p_auth_user_id uuid, p_secret text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  UPDATE public.accounts
  SET auth_user_id      = p_auth_user_id,
      gotrue_secret_enc = extensions.pgp_sym_encrypt(
        p_secret,
        (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
      )
  WHERE lower(id) = lower(trim(p_id));
$$;

-- 2.8 gm_get_player_absences
CREATE OR REPLACE FUNCTION public.gm_get_player_absences(p_uid text)
RETURNS TABLE(id uuid, guild text, pseudo text, start_date date, end_date date, kind text, note text, created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT a.id, a.guild, a.pseudo, a.start_date, a.end_date, a.kind, a.note, a.created_at
  FROM public.player_absences a
  WHERE a.uid = p_uid
  ORDER BY a.start_date DESC;
$$;

-- 2.9 gm_upsert_player_absence
CREATE OR REPLACE FUNCTION public.gm_upsert_player_absence(
  p_guild text,
  p_pseudo text,
  p_uid text,
  p_id uuid,
  p_start_date date,
  p_end_date date,
  p_kind text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_dates');
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.player_absences
    SET start_date = p_start_date,
        end_date   = p_end_date,
        kind       = COALESCE(NULLIF(p_kind, ''), 'full'),
        note       = NULLIF(p_note, ''),
        updated_at = now()
    WHERE id = p_id AND uid = p_uid;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
  ELSE
    INSERT INTO public.player_absences(guild, pseudo, uid, start_date, end_date, kind, note)
    VALUES (p_guild, p_pseudo, p_uid, p_start_date, p_end_date, COALESCE(NULLIF(p_kind, ''), 'full'), NULLIF(p_note, ''));
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2.10 gm_delete_player_absence
CREATE OR REPLACE FUNCTION public.gm_delete_player_absence(p_id uuid, p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  DELETE FROM public.player_absences WHERE id = p_id AND uid = p_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2.11 gm_update_player_timezone
CREATE OR REPLACE FUNCTION public.gm_update_player_timezone(p_uid text, p_offset integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_offset IS NULL OR p_offset < -12 OR p_offset > 14 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_offset');
  END IF;

  UPDATE public.guild_members
  SET timezone_offset = p_offset
  WHERE uid = p_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 2.12 gm_get_push_prefs
CREATE OR REPLACE FUNCTION public.gm_get_push_prefs(p_uid text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid text;
  v_member record;
  v_prefs text[];
BEGIN
  IF p_uid IS NOT NULL AND p_uid <> '' THEN
    v_uid := p_uid;
  ELSE
    SELECT a.uid INTO v_uid
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid();
  END IF;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('event_types', ARRAY['events', 'glory', 'challenges']);
  END IF;

  SELECT * INTO v_member
  FROM public.guild_members gm
  WHERE gm.uid = v_uid
  LIMIT 1;

  IF v_member IS NULL THEN
    RETURN jsonb_build_object('event_types', ARRAY['events', 'glory', 'challenges']);
  END IF;

  SELECT p.event_types INTO v_prefs
  FROM public.player_push_prefs p
  WHERE p.guild = v_member.guild AND lower(p.pseudo) = lower(v_member.pseudo);

  IF v_prefs IS NULL THEN
    v_prefs := ARRAY['events', 'glory', 'challenges'];
  END IF;

  RETURN jsonb_build_object('event_types', v_prefs);
END;
$$;

-- 2.13 gm_set_push_prefs
CREATE OR REPLACE FUNCTION public.gm_set_push_prefs(p_uid text, p_event_types text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid text;
  v_member record;
BEGIN
  IF p_uid IS NOT NULL AND p_uid <> '' THEN
    v_uid := p_uid;
  ELSE
    SELECT a.uid INTO v_uid
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid();
  END IF;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
  END IF;

  SELECT * INTO v_member
  FROM public.guild_members gm
  WHERE gm.uid = v_uid
  LIMIT 1;

  IF v_member IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
  END IF;

  INSERT INTO public.player_push_prefs (guild, pseudo, event_types, updated_at)
  VALUES (v_member.guild, v_member.pseudo, p_event_types, now())
  ON CONFLICT (guild, pseudo) DO UPDATE
    SET event_types = EXCLUDED.event_types,
        updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 3. GRANTS HYGIENE
-- ============================================================================

REVOKE ALL ON FUNCTION public.gm_register_player(text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_register_player(text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_set_join_code(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_set_join_code(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_get_join_code(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_get_join_code(text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_approve_player_account(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_approve_player_account(text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_reject_player_account(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_reject_player_account(text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_get_shadow(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_get_shadow(text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_attach_shadow(text, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_attach_shadow(text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_get_player_absences(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_get_player_absences(text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_upsert_player_absence(text, text, text, uuid, date, date, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_absence(text, text, text, uuid, date, date, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_delete_player_absence(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_delete_player_absence(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_update_player_timezone(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_update_player_timezone(text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.gm_get_push_prefs(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_get_push_prefs(text) TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.gm_set_push_prefs(text, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_set_push_prefs(text, text[]) TO service_role, authenticated;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';

/*
ROLLBACK SQL:
DROP INDEX IF EXISTS public.idx_ep_tenant_session_unique;
DROP INDEX IF EXISTS public.idx_ep_tenant_no_session_unique;
DROP INDEX IF EXISTS public.idx_accounts_lower_id;
DROP INDEX IF EXISTS public.event_status_guild_event_key;
DROP FUNCTION IF EXISTS public.gm_register_player(text, text, text, text);
DROP FUNCTION IF EXISTS public.gm_set_join_code(text, text);
DROP FUNCTION IF EXISTS public.gm_get_join_code(text);
DROP FUNCTION IF EXISTS public.gm_approve_player_account(text);
DROP FUNCTION IF EXISTS public.gm_reject_player_account(text);
DROP FUNCTION IF EXISTS public.gm_get_shadow(text);
DROP FUNCTION IF EXISTS public.gm_attach_shadow(text, uuid, text);
DROP FUNCTION IF EXISTS public.gm_get_player_absences(text);
DROP FUNCTION IF EXISTS public.gm_upsert_player_absence(text, text, text, uuid, date, date, text, text);
DROP FUNCTION IF EXISTS public.gm_delete_player_absence(uuid, text);
DROP FUNCTION IF EXISTS public.gm_update_player_timezone(text, integer);
DROP FUNCTION IF EXISTS public.gm_get_push_prefs(text);
DROP FUNCTION IF EXISTS public.gm_set_push_prefs(text, text[]);
NOTIFY pgrst, 'reload schema';
*/
