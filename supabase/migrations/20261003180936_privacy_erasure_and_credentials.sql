-- 20261003180936_privacy_erasure_and_credentials.sql
--
-- Short-term plan, phase 6 (audit BE-B-12, C0 follow-up), plus the AGENTS.md
-- "no fallback to a real guild" invariant found broken while snapshotting the
-- drifted functions in phase 4b.
--
-- 1. gm_erase_player could not run without a browser session. Erasure requests
--    arrive by e-mail and are executed by the operator from the SQL editor or
--    the service role, where auth.uid() is NULL: check_user_guild_write_access
--    then answers false and the function raised. It now takes the same idiom as
--    gm_erase_account: the guild check applies to a browser caller only. It also
--    clears accounts.uid, which kept the erased player's game identifier.
--    gm_erase_account now also strips the erased account's identifier from the
--    sign-in record it keeps (auth.users is never deleted).
-- 2. The reversible copy of passwords (accounts.password_enc, finding C0) is no
--    longer written. gm_admin_upsert, gm_register_player and
--    gm_reset_account_password write the bcrypt hash only;
--    gm_verify_password drops the copy as soon as a sign-in proves the hash.
--    Existing copies are deleted where the hash exists AND verifies the same
--    password. The 58 accounts that only have the copy keep it until their
--    next sign-in moves them to the hash.
-- 3. gm_list_event_sessions fell back to the real tenant 'ALPHA' when the
--    caller had no guild. Two other functions carried the same COALESCE behind
--    a NULL check that already made it dead. All three now refuse instead.

-- ── 1. GDPR erasure of a player ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_erase_player(p_guild text, p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_pseudo     text;
    v_token      text;
    v_roster     integer := 0;
    v_absences   integer := 0;
    v_names      integer := 0;
    v_transfers  integer := 0;
    v_audit      integer := 0;
    v_accounts   integer := 0;
    v_cascaded   integer := 0;
BEGIN
    IF p_guild IS NULL OR btrim(p_guild) = '' OR p_uid IS NULL OR btrim(p_uid) = '' THEN
        RAISE EXCEPTION 'gm_erase_player: guild and uid are both required';
    END IF;

    -- A browser caller must administer the guild. The operator executing an
    -- e-mailed request runs without a JWT (SQL editor, service role).
    IF auth.uid() IS NOT NULL AND NOT public.check_user_guild_write_access(p_guild) THEN
        RAISE EXCEPTION 'gm_erase_player: not authorised for guild %', p_guild
          USING ERRCODE = '42501';
    END IF;

    SELECT gm.pseudo INTO v_pseudo
      FROM public.guild_members gm
     WHERE gm.guild = p_guild AND gm.uid = p_uid
     LIMIT 1;

    IF v_pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
    END IF;

    SELECT (SELECT count(*) FROM public.event_participants     WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.event_daily_scores     WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.weekly_scores          WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.player_metrics_history WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.sanctions              WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.shadowfront_signups    WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.shadowfront_squads     WHERE guild = p_guild AND pseudo = v_pseudo)
      INTO v_cascaded;

    v_token := 'erased_' || substr(encode(extensions.digest(v_pseudo || gen_random_uuid()::text, 'sha256'), 'hex'), 1, 12);

    UPDATE public.guild_members
       SET pseudo = v_token, uid = NULL, timezone = NULL, timezone_offset = NULL
     WHERE guild = p_guild AND uid = p_uid;
    GET DIAGNOSTICS v_roster = ROW_COUNT;

    DELETE FROM public.player_absences
     WHERE guild = p_guild AND (uid = p_uid OR pseudo = v_pseudo);
    GET DIAGNOSTICS v_absences = ROW_COUNT;

    DELETE FROM public.player_name_history WHERE guild = p_guild AND uid = p_uid;
    GET DIAGNOSTICS v_names = ROW_COUNT;

    DELETE FROM public.guild_transfers
     WHERE uid = p_uid AND (source_guild = p_guild OR target_guild = p_guild);
    GET DIAGNOSTICS v_transfers = ROW_COUNT;

    UPDATE public.system_audit_logs
       SET pseudo = v_token, uid = NULL
     WHERE guild = p_guild AND (uid = p_uid OR pseudo = v_pseudo);
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    -- The account that claimed this player keeps existing (erasing an ACCOUNT
    -- is gm_erase_account), but no longer carries the game identifier.
    UPDATE public.accounts
       SET uid = NULL
     WHERE uid = p_uid AND guild = p_guild;
    GET DIAGNOSTICS v_accounts = ROW_COUNT;

    INSERT INTO public.system_audit_logs (level, service, message, guild, metadata)
    VALUES ('INFO', 'gdpr', 'Player data erased under GDPR Art. 17', p_guild,
            jsonb_build_object('token', v_token, 'rows_carried_by_cascade', v_cascaded));

    RETURN jsonb_build_object(
        'ok', true,
        'token', v_token,
        'anonymised', jsonb_build_object(
            'guild_members', v_roster,
            'rows_carried_by_cascade', v_cascaded,
            'system_audit_logs', v_audit,
            'accounts_uid_cleared', v_accounts),
        'deleted', jsonb_build_object(
            'player_absences', v_absences,
            'player_name_history', v_names,
            'guild_transfers', v_transfers),
        'retained', jsonb_build_object(
            'banned_players', 'kept intact -- Art. 17(3), disclosed in privacy.html section 7.6')
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.gm_erase_player(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_erase_player(text, text) TO authenticated, service_role;

-- ── 1b. GDPR erasure of an account: the sign-in record keeps no identifier ───
-- auth.users rows are never deleted (owner decision, 2026-10-03: sessions are
-- revoked instead). The row kept its app_metadata, which names the erased
-- account (often a Discord-derived name). The metadata goes; the row stays,
-- with a synthetic e-mail and a password nobody knows.

CREATE OR REPLACE FUNCTION public.gm_erase_account(p_account_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_guild   text;
    v_role    text;
    v_auth    uuid;
    v_token   text;
    v_pages   integer := 0;
    v_comm    integer := 0;
BEGIN
    IF p_account_id IS NULL OR btrim(p_account_id) = '' THEN
        RAISE EXCEPTION 'gm_erase_account: account id is required';
    END IF;

    SELECT a.guild, a.role, a.auth_user_id INTO v_guild, v_role, v_auth
      FROM public.accounts a WHERE a.id = p_account_id;

    IF v_guild IS NULL AND v_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
    END IF;

    IF auth.uid() IS NOT NULL AND NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'gm_erase_account: super_admin only'
          USING ERRCODE = '42501';
    END IF;

    v_token := 'erased_' || substr(encode(extensions.digest(p_account_id || gen_random_uuid()::text, 'sha256'), 'hex'), 1, 12);

    UPDATE public.migration_wiki_pages
       SET created_by_pseudo = CASE WHEN created_by_account_id = p_account_id THEN v_token ELSE created_by_pseudo END,
           updated_by_pseudo = CASE WHEN updated_by_account_id = p_account_id THEN v_token ELSE updated_by_pseudo END
     WHERE created_by_account_id = p_account_id OR updated_by_account_id = p_account_id;
    GET DIAGNOSTICS v_pages = ROW_COUNT;

    UPDATE public.migration_wiki_comments
       SET author_pseudo = v_token
     WHERE author_account_id = p_account_id;
    GET DIAGNOSTICS v_comm = ROW_COUNT;

    PERFORM public.gm_revoke_auth_sessions(v_auth);

    IF v_auth IS NOT NULL THEN
        UPDATE auth.users
           SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) - 'account_id' - 'app_role',
               raw_user_meta_data = '{}'::jsonb
         WHERE id = v_auth;
    END IF;

    DELETE FROM public.accounts WHERE id = p_account_id;

    INSERT INTO public.system_audit_logs (level, service, message, guild, metadata)
    VALUES ('INFO', 'gdpr', 'Account erased under GDPR Art. 17', v_guild,
            jsonb_build_object('token', v_token, 'role', v_role));

    RETURN jsonb_build_object('ok', true, 'token', v_token,
                             'wiki_pages_anonymised', v_pages,
                             'wiki_comments_anonymised', v_comm);
END;
$function$;
REVOKE ALL ON FUNCTION public.gm_erase_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_erase_account(text) TO authenticated, service_role;

-- ── 2. No more reversible password copies (C0) ───────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(p_id text, p_password text, p_role text, p_guild text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_id  text := TRIM(p_id);
BEGIN
    -- Browser callers no longer hold EXECUTE. The gate stays as a second wall
    -- in case a future migration re-grants it.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.is_super_admin() THEN
            IF p_role IN ('super_admin', 'server_admin') THEN
                RAISE EXCEPTION 'forbidden';
            END IF;
            IF NOT public.check_user_guild_write_access(p_guild) THEN
                RAISE EXCEPTION 'Access denied';
            END IF;
        END IF;
    END IF;

    IF v_id IS NULL OR v_id = '' THEN
        RAISE EXCEPTION 'id_required';
    END IF;
    IF p_password IS NULL OR length(TRIM(p_password)) = 0 THEN
        RAISE EXCEPTION 'password_required';
    END IF;

    -- Case-insensitive, like sign-in. A concurrent create of the same id that
    -- slips past this check still fails on idx_accounts_lower_id with the same
    -- SQLSTATE, so the caller sees one error either way.
    IF EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(v_id)) THEN
        RAISE EXCEPTION 'account_exists' USING ERRCODE = 'unique_violation';
    END IF;

    -- The bcrypt hash only: no reversible copy (finding C0).
    INSERT INTO public.accounts (id, role, password_hash, guild, status, created_at)
    VALUES (
        v_id,
        COALESCE(p_role, 'guild_admin'),
        extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
        p_guild,
        'active',
        now()
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_register_player(p_id text, p_password text, p_uid text, p_join_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_guild text;
  v_uid_ok boolean;
  v_uid_taken boolean;
  v_id_taken boolean;
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

  -- The bcrypt hash only: no reversible copy (finding C0).
  INSERT INTO public.accounts(id, role, password_hash, guild, uid, status, created_at)
  VALUES (
    trim(p_id),
    'member',
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
    v_guild,
    p_uid,
    'pending',
    now()
  );

  RETURN jsonb_build_object('ok', true, 'status', 'pending');
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_reset_account_password(p_id text, p_password text)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_role text;
    v_target_guild text;
    v_target_server text;
BEGIN
    IF p_id IS NULL OR p_password IS NULL OR length(p_password) < 6 THEN
        RETURN QUERY SELECT false, 'invalid_password'::text;
        RETURN;
    END IF;

    IF auth.uid() IS NOT NULL THEN
        SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
        INTO v_caller_role, v_caller_guild, v_caller_server
        FROM public.accounts a
        LEFT JOIN public.guilds g ON g.id = a.guild
        WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active'
        LIMIT 1;

        IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
            RETURN QUERY SELECT false, 'forbidden'::text;
            RETURN;
        END IF;

        IF v_caller_role <> 'super_admin' THEN
            SELECT a2.role, a2.guild, COALESCE(a2.server_number, g2.server_number)
            INTO v_target_role, v_target_guild, v_target_server
            FROM public.accounts a2
            LEFT JOIN public.guilds g2 ON g2.id = a2.guild
            WHERE LOWER(a2.id) = LOWER(p_id)
            LIMIT 1;

            IF v_target_role = 'super_admin' THEN
                RETURN QUERY SELECT false, 'forbidden'::text;
                RETURN;
            END IF;

            IF v_caller_role = 'server_admin' THEN
                IF v_caller_server IS NULL OR v_target_server IS NULL OR v_caller_server <> v_target_server THEN
                    RETURN QUERY SELECT false, 'forbidden'::text;
                    RETURN;
                END IF;
            ELSIF v_caller_role = 'guild_admin' THEN
                IF v_target_role = 'server_admin' OR v_caller_guild IS NULL OR v_target_guild IS NULL OR v_caller_guild <> v_target_guild THEN
                    RETURN QUERY SELECT false, 'forbidden'::text;
                    RETURN;
                END IF;
            END IF;
        END IF;
    END IF;

    -- The bcrypt hash only, and any old reversible copy goes with the reset
    -- (finding C0): it would otherwise still hold the previous password.
    UPDATE public.accounts
    SET password_enc = NULL,
        password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
        failed_login_count = 0,
        locked_until = NULL
    WHERE LOWER(id) = LOWER(p_id);

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'account_not_found'::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT true, NULL::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_verify_password(p_id text, p_password text)
RETURNS TABLE(canonical_id text, role text, status text, is_locked boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '5s'
AS $function$
DECLARE
    v_acc record;
    v_is_match boolean := false;
    v_key text;
    v_now_locked boolean;
BEGIN
    SELECT a.id, a.role, a.status, a.password_enc, a.password_hash, a.failed_login_count, a.locked_until
    INTO v_acc
    FROM public.accounts a
    WHERE LOWER(a.id) = LOWER(TRIM(p_id))
    LIMIT 1;

    IF v_acc.id IS NULL THEN
        RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, false, 'invalid_credentials'::text;
        RETURN;
    END IF;

    IF v_acc.locked_until IS NOT NULL AND v_acc.locked_until > now() THEN
        RETURN QUERY SELECT v_acc.id, v_acc.role, v_acc.status, true, 'account_locked'::text;
        RETURN;
    END IF;

    -- An account whose credentials were destroyed by the Discord claim flow has
    -- both columns NULL: it must fail closed, not fall through to a comparison.
    IF (v_acc.password_hash IS NULL OR v_acc.password_hash = '')
       AND v_acc.password_enc IS NULL THEN
        RETURN QUERY SELECT v_acc.id, NULL::text, NULL::text, false, 'invalid_credentials'::text;
        RETURN;
    END IF;

    IF v_acc.password_hash IS NOT NULL AND v_acc.password_hash <> '' THEN
        v_is_match := (extensions.crypt(p_password, v_acc.password_hash) = v_acc.password_hash);
    END IF;

    -- Legacy accounts that only have the reversible copy: one last decryption,
    -- then the hash replaces it.
    IF NOT v_is_match AND v_acc.password_enc IS NOT NULL THEN
        SELECT s.decrypted_secret INTO v_key
        FROM vault.decrypted_secrets s
        WHERE s.name = 'gm_accounts_key';

        IF v_key IS NOT NULL THEN
            BEGIN
                v_is_match := (extensions.pgp_sym_decrypt(v_acc.password_enc, v_key) = p_password);
            EXCEPTION WHEN OTHERS THEN
                v_is_match := false;
            END;
        END IF;

        IF v_is_match THEN
            UPDATE public.accounts
            SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
            WHERE id = v_acc.id;
        END IF;
    END IF;

    IF v_is_match THEN
        -- The hash now verifies this password: the reversible copy has no use
        -- left (finding C0).
        UPDATE public.accounts
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now(),
            password_enc = NULL
        WHERE id = v_acc.id;

        RETURN QUERY SELECT v_acc.id, COALESCE(v_acc.role, 'member'), COALESCE(v_acc.status, 'active'), false, NULL::text;
        RETURN;
    ELSE
        UPDATE public.accounts
        SET failed_login_count = public.accounts.failed_login_count + 1,
            locked_until = CASE
                WHEN public.accounts.failed_login_count + 1 >= 5 THEN
                    now() + (interval '15 minutes' * LEAST(4, GREATEST(1, (public.accounts.failed_login_count + 1) / 5)))
                ELSE NULL
            END
        WHERE id = v_acc.id
        RETURNING COALESCE(locked_until > now(), false)
        INTO v_now_locked;

        RETURN QUERY SELECT v_acc.id, NULL::text, NULL::text, v_now_locked, 'invalid_credentials'::text;
        RETURN;
    END IF;
END;
$function$;

-- Delete the copies the hash already makes redundant: only where the hash
-- exists AND verifies the very password the copy holds. A copy that disagrees
-- with its hash is left alone and counted, never guessed at.
DO $purge$
DECLARE
    v_key       text;
    v_row       record;
    v_agrees    boolean;
    v_cleared   integer := 0;
    v_kept      integer := 0;
BEGIN
    SELECT s.decrypted_secret INTO v_key FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key';
    IF v_key IS NULL THEN
        RAISE NOTICE 'gm_accounts_key not in the vault: no copy can be verified, none cleared';
        RETURN;
    END IF;

    FOR v_row IN
        SELECT a.id, a.password_enc, a.password_hash FROM public.accounts a
         WHERE a.password_enc IS NOT NULL AND a.password_hash IS NOT NULL AND a.password_hash <> ''
    LOOP
        BEGIN
            v_agrees := extensions.crypt(extensions.pgp_sym_decrypt(v_row.password_enc, v_key), v_row.password_hash)
                        = v_row.password_hash;
        EXCEPTION WHEN OTHERS THEN
            v_agrees := false;  -- unreadable copy: leave it, count it
        END;
        IF v_agrees THEN
            UPDATE public.accounts SET password_enc = NULL WHERE id = v_row.id;
            v_cleared := v_cleared + 1;
        ELSE
            v_kept := v_kept + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'password_enc cleared on % account(s); % kept because the copy disagrees with the hash', v_cleared, v_kept;
END
$purge$;

-- ── 3. No fallback to a real tenant ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_list_event_sessions(p_guild text DEFAULT NULL::text)
RETURNS TABLE(event_name text, display_name text, session_id text, week_start date, start_at timestamp with time zone, participants integer, participated_count integer, total_score bigint, granular boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_guild text;
    v_target_server text;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active';

    -- Only admins (or super admins) may list sessions; members use the portal.
    IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
        RETURN;
    END IF;

    -- No fallback: an unresolved guild lists nothing. This used to default to
    -- 'ALPHA', a real tenant (AGENTS.md).
    IF v_caller_role = 'guild_admin' THEN
        v_target_guild := v_caller_guild;
    ELSE
        v_target_guild := COALESCE(p_guild, v_caller_guild);
    END IF;
    IF v_target_guild IS NULL OR v_target_guild = '' THEN
        RETURN;
    END IF;

    IF v_caller_role = 'server_admin' THEN
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target_guild;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
            RETURN;
        END IF;
    END IF;

    RETURN QUERY
    SELECT base.event_name,
           base.display_name,
           base.session_id,
           base.week_start,
           base.start_at,
           base.participants,
           base.participated_count,
           base.total_score,
           EXISTS (
               SELECT 1 FROM public.war_sessions ws
               WHERE ws.guild = v_target_guild
                 AND ws.event_name = base.event_name
                 AND ws.session_id = base.session_id
           ) AS granular
    FROM (
        SELECT
            ep.event_name,
            COALESCE(es.event_name, ep.event_name) AS display_name,
            COALESCE(ep.session_id, ep.week_start::text) AS session_id,
            MIN(ep.week_start) AS week_start,
            MAX(es.start_at) AS start_at,
            COUNT(*)::integer AS participants,
            SUM(CASE WHEN ep.participated > 0 OR COALESCE(ep.score, 0) > 0 OR COALESCE(ep.score_prep, 0) > 0 OR COALESCE(ep.score_pvp, 0) > 0 THEN 1 ELSE 0 END)::integer AS participated_count,
            SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0))::bigint AS total_score
        FROM public.event_participants ep
        LEFT JOIN public.event_status es
          ON es.guild = ep.guild
         AND es.session_id = ep.session_id
         AND (
           LOWER(es.event_name) = LOWER(ep.event_name)
           OR (ep.event_name = 'Shadowfront' AND es.event_name LIKE 'Shadowfront%')
         )
        WHERE ep.guild = v_target_guild
        GROUP BY ep.event_name, COALESCE(es.event_name, ep.event_name), COALESCE(ep.session_id, ep.week_start::text)
    ) base
    ORDER BY COALESCE(
      base.start_at,
      CASE
        WHEN base.session_id ~ '-[0-9]{8}(-[0-9]+)?$'
        THEN to_timestamp(
               substring(base.session_id FROM '-([0-9]{8})'),
               'YYYYMMDD'
             ) AT TIME ZONE 'UTC'
        ELSE NULL
      END,
      (base.week_start || 'T12:00:00')::timestamptz
    ) DESC;
END;
$function$;

-- The other two: p_guild is already refused when NULL, so the COALESCE was
-- dead. Rewritten from the live body, which must still be production's.
DO $alpha$
DECLARE
    v_sig text;
    v_def text;
BEGIN
    FOREACH v_sig IN ARRAY ARRAY[
        'gm_approve_participant_submission(text,text,text,text)',
        'gm_sync_shadowfront_participants(text,text)'
    ] LOOP
        v_def := pg_get_functiondef(('public.' || v_sig)::regprocedure);
        IF position('v_target := COALESCE(UPPER(p_guild), ''ALPHA'');' IN v_def) = 0 THEN
            RAISE NOTICE '%: no ALPHA fallback left', v_sig;
            CONTINUE;
        END IF;
        EXECUTE replace(v_def,
            'v_target := COALESCE(UPPER(p_guild), ''ALPHA'');',
            'v_target := UPPER(p_guild);  -- p_guild is non-NULL here; no fallback to a real tenant');
    END LOOP;
END
$alpha$;

-- ── 4. Assert the end state ──────────────────────────────────────────────────

DO $check$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('gm_admin_upsert', 'gm_register_player', 'gm_reset_account_password')
               AND p.prosrc ~ 'pgp_sym_encrypt') THEN
        RAISE EXCEPTION 'a function still writes a reversible password copy';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('gm_list_event_sessions', 'gm_approve_participant_submission', 'gm_sync_shadowfront_participants')
               AND p.prosrc ~ 'COALESCE\([^)]*''ALPHA''') THEN
        RAISE EXCEPTION 'a function still falls back to the ALPHA tenant';
    END IF;
    IF pg_get_functiondef('public.gm_erase_player(text,text)'::regprocedure) !~ 'IF auth\.uid\(\) IS NOT NULL AND NOT public\.check_user_guild_write_access' THEN
        RAISE EXCEPTION 'gm_erase_player still refuses the operator';
    END IF;
    IF pg_get_functiondef('public.gm_erase_account(text)'::regprocedure) !~ '- ''account_id''' THEN
        RAISE EXCEPTION 'gm_erase_account still leaves the account identifier on the sign-in record';
    END IF;
    IF has_function_privilege('anon', 'public.gm_erase_player(text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_erase_player is executable by anon';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
