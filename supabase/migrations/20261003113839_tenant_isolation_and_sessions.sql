-- 20261003113839_tenant_isolation_and_sessions.sql
--
-- Short-term plan, phase 2: tenant isolation and session revocation
-- (audit SEC-05, SEC-07, SEC-08, DB-05, DB-06, DB-07, BE-B-06, BE-B-07, BE-B-21).
-- Owner decisions, 2026-10-03:
--   * wiki: only the author guild edits or deletes a page; authorship is set by the server;
--   * banned players: re-adding a banned UID is refused by the database;
--   * sign-in identities are never deleted here. When an account goes, its
--     sessions and refresh tokens go; the identity stays, unusable, since the
--     secret it signs in with lived in the deleted account row.
--
-- Every rewrite of a live body below either checks the md5 it was written
-- against or is idempotent, and the last block asserts the end state.

-- ═══ 1. Who is calling, and is that session still valid? ═══════════════════

-- The caller's guild, for a still-valid session of an active account. Used by
-- the wiki policies; NULL when there is no such caller.
CREATE OR REPLACE FUNCTION public.gm_caller_guild()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.guild
  FROM public.accounts a
  WHERE a.auth_user_id = (SELECT auth.uid())
    AND a.status = 'active'
    AND (SELECT public.gm_session_is_valid())
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.gm_caller_guild() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_caller_guild() TO authenticated, service_role;

-- SEC-05: a plain member reached the guild_admin branch of the transfer.
DO $transfer$
DECLARE
  v_def text := pg_get_functiondef('public.gm_transfer_guild_member(text,text,text)'::regprocedure);
  v_old text := E'    IF v_caller_role IS NULL THEN\n        RETURN jsonb_build_object(''ok'', false, ''error'', ''unauthorized'');\n    END IF;\n';
BEGIN
  IF v_def ~ 'v_caller_role NOT IN' THEN
    RAISE NOTICE 'gm_transfer_guild_member already refuses members';
    RETURN;
  END IF;
  -- An empty replay has the repository's earlier body: the md5 pins production's.
  IF current_setting('gm.replay', true) = 'on' AND position(v_old IN v_def) = 0 THEN
    RAISE NOTICE 'replay: gm_transfer_guild_member left to the snapshot migrations'; RETURN;
  END IF;
  IF (md5(v_def) <> 'fd0994eaea64352d1d35bdb9194dfdba' AND current_setting('gm.replay', true) IS DISTINCT FROM 'on') OR position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'gm_transfer_guild_member changed since this migration was written; re-read it first';
  END IF;
  v_def := replace(v_def, v_old,
    v_old || E'    -- Moving a player is an officer act; a member must use request_guild_transfer.\n'
          || E'    IF v_caller_role NOT IN (''super_admin'', ''server_admin'', ''guild_admin'') THEN\n'
          || E'        RETURN jsonb_build_object(''ok'', false, ''error'', ''unauthorized'');\n'
          || E'    END IF;\n');
  EXECUTE v_def;
END
$transfer$;

-- BE-B-07: these functions resolve the caller inline and never asked whether
-- the session had been revoked. Each gets the same check the shared helpers
-- apply. A revoked session now finds no account, and every one of these
-- functions already refuses (or returns nothing) when it finds none: reviewed
-- one by one before writing this.
DO $sessions$
DECLARE
  v_sig text;
  v_def text;
  v_new text;
  v_hits int;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'check_uid_exists_globally(text)',
    'gm_admin_request_transfer(text,text)',
    'gm_approve_participant_submission(text,text,text,text)',
    'gm_can_access_server_wiki(text)',
    'gm_can_read_account(text)',
    'gm_create_ticket(text,text,text,text,text,text,text,jsonb)',
    'gm_delete_guild(text)',
    'gm_find_player_by_uid(text)',
    'gm_get_player_event_history(text,integer)',
    'gm_get_player_metrics_history(text,integer)',
    'gm_guild_tag_history(text)',
    'gm_list_event_sessions(text)',
    'gm_personal_kpis(text)',
    'gm_rename_guild(text,text)',
    'gm_reset_account_password(text,text)',
    'gm_save_chest_tiers(text,text,jsonb)',
    'gm_stats_weeks(text)',
    'gm_sync_shadowfront_participants(text,text)',
    'gm_transfer_guild_member(text,text,text)',
    'gm_unsync_shadowfront_participant(text,text,text)',
    'request_guild_transfer(text,text)',
    'resolve_guild_transfer(uuid,text)'
  ] LOOP
    IF to_regprocedure('public.' || v_sig) IS NULL THEN
      RAISE NOTICE 'skipping %: not defined', v_sig;
      CONTINUE;
    END IF;
    v_def := pg_get_functiondef(('public.' || v_sig)::regprocedure);
    IF v_def ~ 'gm_session_is_valid' THEN
      CONTINUE;  -- already done
    END IF;
    v_hits := (SELECT count(*) FROM regexp_matches(v_def, 'auth_user_id\s*=\s*auth\.uid\(\)', 'g'));
    IF v_hits = 0 AND current_setting('gm.replay', true) = 'on' THEN
      CONTINUE;  -- replay: left to the snapshot migrations
    END IF;
    IF v_hits = 0 THEN
      RAISE EXCEPTION '%: no inline caller resolution found; re-read it first', v_sig;
    END IF;
    v_new := regexp_replace(v_def, 'auth_user_id\s*=\s*auth\.uid\(\)',
                            'auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid())', 'g');
    IF (SELECT count(*) FROM regexp_matches(v_new, '\(SELECT public\.gm_session_is_valid\(\)\)', 'g')) <> v_hits THEN
      RAISE EXCEPTION '%: session check not applied to every caller lookup', v_sig;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$sessions$;

-- DB-06: absences were readable through an e-mail match with no status or
-- session check and an 'ALPHA' fallback. Same audience as before (super_admin,
-- or the guild_admin of that guild), resolved properly.
CREATE OR REPLACE FUNCTION public.gm_can_admin_see_absences(p_guild text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT public.gm_session_is_valid())
     AND (
       public.is_super_admin()
       OR EXISTS (
         SELECT 1 FROM public.accounts a
         WHERE a.auth_user_id = (SELECT auth.uid())
           AND a.status = 'active'
           AND a.role = 'guild_admin'
           AND a.guild = p_guild
       )
     );
$$;

ALTER POLICY player_absences_select_policy ON public.player_absences
  USING (
    public.gm_can_admin_see_absences(guild)
    OR (
      (SELECT public.gm_session_is_valid())
      AND EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = (SELECT auth.uid())
          AND a.status = 'active'
          AND a.uid = player_absences.uid
      )
    )
  );

ALTER POLICY ocr_cache_admin_select ON public.ocr_cache
  USING (public.is_super_admin() OR (guild_id IS NOT NULL AND public.gm_can_read_guild_data(guild_id)));

-- ═══ 2. Migration wiki: the author guild owns its pages (SEC-08, DB-07) ═════

ALTER TABLE public.migration_wiki_pages ADD COLUMN IF NOT EXISTS owner_guild text;

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'migration_wiki_pages_owner_guild_fkey') THEN
    ALTER TABLE public.migration_wiki_pages
      ADD CONSTRAINT migration_wiki_pages_owner_guild_fkey FOREIGN KEY (owner_guild)
      REFERENCES public.guilds(id) ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END
$fk$;

-- Existing pages: a guild page belongs to its guild; a server page to the
-- guild its author belonged to.
UPDATE public.migration_wiki_pages p
SET owner_guild = CASE
      WHEN p.scope = 'guild' THEN p.guild_id
      ELSE (SELECT a.guild FROM public.accounts a WHERE a.id = p.created_by_account_id)
    END
WHERE p.owner_guild IS NULL;

-- Authorship comes from the session, never from the request body.
CREATE OR REPLACE FUNCTION public.gm_wiki_page_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acc text; v_guild text; v_pseudo text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;  -- service role: trusted, as everywhere else
  END IF;

  SELECT a.id, a.guild,
         COALESCE((SELECT gm.pseudo FROM public.guild_members gm
                   WHERE gm.uid = a.uid AND gm.guild = a.guild LIMIT 1), a.id)
    INTO v_acc, v_guild, v_pseudo
  FROM public.accounts a
  WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
    AND (SELECT public.gm_session_is_valid())
  LIMIT 1;

  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by_account_id := v_acc;
    NEW.created_by_pseudo     := v_pseudo;
    NEW.owner_guild           := CASE WHEN NEW.scope = 'guild' THEN NEW.guild_id ELSE v_guild END;
    NEW.created_at            := now();
  ELSE
    -- What a page is, where it lives and who wrote it never change.
    NEW.id                    := OLD.id;
    NEW.scope                 := OLD.scope;
    NEW.server_number         := OLD.server_number;
    NEW.guild_id              := OLD.guild_id;
    NEW.owner_guild           := OLD.owner_guild;
    NEW.created_by_account_id := OLD.created_by_account_id;
    NEW.created_by_pseudo     := OLD.created_by_pseudo;
    NEW.created_at            := OLD.created_at;
  END IF;
  NEW.updated_by_account_id := v_acc;
  NEW.updated_by_pseudo     := v_pseudo;
  NEW.updated_at            := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gm_wiki_page_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_migration_wiki_pages_stamp ON public.migration_wiki_pages;
CREATE TRIGGER trg_migration_wiki_pages_stamp
  BEFORE INSERT OR UPDATE ON public.migration_wiki_pages
  FOR EACH ROW EXECUTE FUNCTION public.gm_wiki_page_stamp();

CREATE OR REPLACE FUNCTION public.gm_wiki_comment_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acc text; v_guild text; v_role text; v_pseudo text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.id, a.guild, a.role,
         COALESCE((SELECT gm.pseudo FROM public.guild_members gm
                   WHERE gm.uid = a.uid AND gm.guild = a.guild LIMIT 1), a.id)
    INTO v_acc, v_guild, v_role, v_pseudo
  FROM public.accounts a
  WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
    AND (SELECT public.gm_session_is_valid())
  LIMIT 1;

  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  NEW.author_account_id := v_acc;
  NEW.author_pseudo     := v_pseudo;
  NEW.author_guild_id   := v_guild;
  NEW.author_role       := v_role;
  NEW.created_at        := now();
  NEW.updated_at        := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gm_wiki_comment_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_migration_wiki_comments_stamp ON public.migration_wiki_comments;
CREATE TRIGGER trg_migration_wiki_comments_stamp
  BEFORE INSERT ON public.migration_wiki_comments
  FOR EACH ROW EXECUTE FUNCTION public.gm_wiki_comment_stamp();

-- Edit and delete: the author guild (or a super_admin), on top of the read
-- access it already needed. Reading and adding stay server-wide.
ALTER POLICY gm_migration_wiki_update ON public.migration_wiki_pages
  USING (
    public.is_super_admin()
    OR (
      owner_guild IS NOT NULL
      AND owner_guild = public.gm_caller_guild()
      AND ((scope = 'guild' AND public.check_user_guild_access(guild_id))
           OR (scope = 'server' AND public.gm_can_access_server_wiki(server_number)))
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      owner_guild IS NOT NULL
      AND owner_guild = public.gm_caller_guild()
      AND ((scope = 'guild' AND public.check_user_guild_access(guild_id))
           OR (scope = 'server' AND public.gm_can_access_server_wiki(server_number)))
    )
  );

ALTER POLICY gm_migration_wiki_delete ON public.migration_wiki_pages
  USING (
    public.is_super_admin()
    OR (
      owner_guild IS NOT NULL
      AND owner_guild = public.gm_caller_guild()
      AND ((scope = 'guild' AND public.check_user_guild_access(guild_id))
           OR (scope = 'server' AND public.gm_can_access_server_wiki(server_number)))
    )
  );

ALTER POLICY gm_migration_wiki_comments_delete ON public.migration_wiki_comments
  USING (
    public.is_super_admin()
    OR (
      (SELECT public.gm_session_is_valid())
      AND author_account_id = (SELECT a.id FROM public.accounts a
                               WHERE a.auth_user_id = (SELECT auth.uid()) AND a.status = 'active' LIMIT 1)
      AND public.gm_can_access_wiki_page(page_id)
    )
  );

-- Only content can be updated through the API. The updated_by_* columns stay
-- grantable for clients built before this change; the trigger overwrites them.
REVOKE UPDATE ON public.migration_wiki_pages FROM authenticated;
GRANT UPDATE (title, content, category, is_pinned, attachments, updated_at, updated_by_account_id, updated_by_pseudo)
  ON public.migration_wiki_pages TO authenticated;

-- ═══ 3. Banned players cannot be put back on the roster (BE-B-06) ═══════════

CREATE OR REPLACE FUNCTION public.gm_refuse_banned_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.guild IS NOT DISTINCT FROM OLD.guild
     AND NEW.uid IS NOT DISTINCT FROM OLD.uid THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.uid, '') <> '' AND EXISTS (
    SELECT 1 FROM public.banned_players b
    WHERE b.guild = NEW.guild AND b.uid = NEW.uid
  ) THEN
    RAISE EXCEPTION 'uid_banned' USING ERRCODE = 'check_violation',
      HINT = 'This UID is banned by the guild. Lift the ban before adding the player.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gm_refuse_banned_member() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guild_members_refuse_banned ON public.guild_members;
CREATE TRIGGER trg_guild_members_refuse_banned
  BEFORE INSERT OR UPDATE OF guild, uid ON public.guild_members
  FOR EACH ROW EXECUTE FUNCTION public.gm_refuse_banned_member();

-- ═══ 4. A deleted account keeps no session (SEC-07, BE-B-21, DB-05) ═════════

-- Revoking must end the session, not just re-stamp the next token: the
-- refresh token used to mint a fresh, valid JWT at the new epoch. Called by
-- bumpSessionVersion (Edge Functions) and by the deletions below.
CREATE OR REPLACE FUNCTION public.gm_revoke_auth_sessions(p_auth_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM auth.sessions WHERE user_id = p_auth_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM auth.refresh_tokens WHERE user_id = p_auth_user_id::text;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.gm_revoke_auth_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_revoke_auth_sessions(uuid) TO service_role;

-- Guild deletion: only that guild's own officers and players go, and their
-- sessions with them. A server_admin or super_admin attached to the guild
-- keeps the account (audit DB-05): it loses the guild and keeps the server
-- the guild gave it.
DO $purge$
DECLARE
  v_def text := pg_get_functiondef('public.gm_purge_guild_data(text)'::regprocedure);
  v_old text := E'    DELETE FROM public.accounts WHERE guild = v_guild AND (role IS NULL OR role <> ''super_admin'');\n'
             || E'    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object(''accounts'', v_n);\n';
BEGIN
  IF v_def ~ 'gm_revoke_auth_sessions' THEN
    RAISE NOTICE 'gm_purge_guild_data already revokes sessions';
    RETURN;
  END IF;
  IF current_setting('gm.replay', true) = 'on' AND position(v_old IN v_def) = 0 THEN
    RAISE NOTICE 'replay: gm_purge_guild_data left to the snapshot migrations'; RETURN;
  END IF;
  IF (md5(v_def) <> 'af62cc5a9350260f6fc165679f2bc177' AND current_setting('gm.replay', true) IS DISTINCT FROM 'on') OR position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'gm_purge_guild_data changed since this migration was written; re-read it first';
  END IF;
  v_def := replace(v_def, v_old,
       E'    PERFORM public.gm_revoke_auth_sessions(a.auth_user_id)\n'
    || E'       FROM public.accounts a\n'
    || E'      WHERE a.guild = v_guild AND a.auth_user_id IS NOT NULL\n'
    || E'        AND (a.role IS NULL OR a.role IN (''guild_admin'', ''member''));\n'
    || E'    DELETE FROM public.accounts\n'
    || E'     WHERE guild = v_guild AND (role IS NULL OR role IN (''guild_admin'', ''member''));\n'
    || E'    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object(''accounts'', v_n);\n'
    || E'    UPDATE public.accounts a\n'
    || E'       SET server_number = COALESCE(a.server_number, (SELECT g.server_number FROM public.guilds g WHERE g.id = v_guild)),\n'
    || E'           guild = NULL\n'
    || E'     WHERE a.guild = v_guild AND a.role IN (''server_admin'', ''super_admin'');\n'
    || E'    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object(''accounts_detached'', v_n);\n');
  EXECUTE v_def;
END
$purge$;

-- GDPR erasure: the account's sessions end with it, and the function now runs
-- for the service role too (it refused anything without a JWT, BE-B-12).
DO $erase$
DECLARE
  v_def text := pg_get_functiondef('public.gm_erase_account(text)'::regprocedure);
  v_gate text := E'    IF NOT public.is_super_admin() THEN\n';
  v_del  text := E'    DELETE FROM public.accounts WHERE id = p_account_id;\n';
BEGIN
  IF v_def ~ 'gm_revoke_auth_sessions' THEN
    RAISE NOTICE 'gm_erase_account already revokes sessions';
    RETURN;
  END IF;
  IF current_setting('gm.replay', true) = 'on' AND (position(v_gate IN v_def) = 0 OR position(v_del IN v_def) = 0) THEN
    RAISE NOTICE 'replay: gm_erase_account left to the snapshot migrations'; RETURN;
  END IF;
  IF (md5(v_def) <> '582705fb224c2be47f4d9d2cd5cc42f6' AND current_setting('gm.replay', true) IS DISTINCT FROM 'on') OR position(v_gate IN v_def) = 0 OR position(v_del IN v_def) = 0 THEN
    RAISE EXCEPTION 'gm_erase_account changed since this migration was written; re-read it first';
  END IF;
  v_def := replace(v_def, v_gate, E'    IF auth.uid() IS NOT NULL AND NOT public.is_super_admin() THEN\n');
  v_def := replace(v_def, v_del,
       E'    PERFORM public.gm_revoke_auth_sessions(\n'
    || E'      (SELECT a.auth_user_id FROM public.accounts a WHERE a.id = p_account_id));\n'
    || v_del);
  EXECUTE v_def;
END
$erase$;

-- The sign-in identities already orphaned keep no session: no account points
-- at them, and the account their token names no longer exists. 45 identities
-- and 31 live refresh tokens on production when this was written.
SELECT public.gm_revoke_auth_sessions(u.id)
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.auth_user_id = u.id)
  AND u.raw_app_meta_data ? 'account_id'
  AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(u.raw_app_meta_data->>'account_id'));

-- ═══ 5. Assert the end state ═════════════════════════════════════════════

DO $check$
DECLARE
  v_sig text;
  -- Function BODIES are production's only after the snapshot_drifted_functions
  -- migrations, which check every one by md5. An empty replay skips the body
  -- checks here and keeps the policy and grant checks.
  v_bodies boolean := current_setting('gm.replay', true) IS DISTINCT FROM 'on';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'check_uid_exists_globally(text)', 'gm_admin_request_transfer(text,text)',
    'gm_approve_participant_submission(text,text,text,text)', 'gm_can_access_server_wiki(text)',
    'gm_can_read_account(text)', 'gm_create_ticket(text,text,text,text,text,text,text,jsonb)',
    'gm_delete_guild(text)', 'gm_find_player_by_uid(text)', 'gm_get_player_event_history(text,integer)',
    'gm_get_player_metrics_history(text,integer)', 'gm_guild_tag_history(text)', 'gm_list_event_sessions(text)',
    'gm_personal_kpis(text)', 'gm_rename_guild(text,text)', 'gm_reset_account_password(text,text)',
    'gm_save_chest_tiers(text,text,jsonb)', 'gm_stats_weeks(text)', 'gm_sync_shadowfront_participants(text,text)',
    'gm_transfer_guild_member(text,text,text)', 'gm_unsync_shadowfront_participant(text,text,text)',
    'request_guild_transfer(text,text)', 'resolve_guild_transfer(uuid,text)', 'gm_can_admin_see_absences(text)'
  ] LOOP
    IF v_bodies AND to_regprocedure('public.' || v_sig) IS NOT NULL
       AND pg_get_functiondef(('public.' || v_sig)::regprocedure) !~ 'gm_session_is_valid' THEN
      RAISE EXCEPTION '% still ignores session revocation', v_sig;
    END IF;
  END LOOP;

  IF v_bodies AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind = 'f'
               AND pg_get_functiondef(p.oid) ~ 'auth_user_id\s*=\s*(\(SELECT\s+)?auth\.uid\(\)'
               AND pg_get_functiondef(p.oid) !~ 'gm_session_is_valid') THEN
    RAISE EXCEPTION 'a function still resolves its caller without a session check';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
               AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'auth_user_id'
               AND (coalesce(qual, '') || coalesce(with_check, '')) !~ 'gm_session_is_valid') THEN
    RAISE EXCEPTION 'a policy still resolves its caller without a session check';
  END IF;

  IF v_bodies AND pg_get_functiondef('public.gm_transfer_guild_member(text,text,text)'::regprocedure) !~ 'v_caller_role NOT IN' THEN
    RAISE EXCEPTION 'members can still transfer players';
  END IF;
  IF v_bodies AND pg_get_functiondef('public.gm_can_admin_see_absences(text)'::regprocedure) ~ '(ALPHA|jwt)' THEN
    RAISE EXCEPTION 'gm_can_admin_see_absences still matches by e-mail or falls back to ALPHA';
  END IF;
  IF has_table_privilege('authenticated', 'public.migration_wiki_pages', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.migration_wiki_pages', 'created_by_account_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.migration_wiki_pages', 'owner_guild', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.migration_wiki_pages', 'content', 'UPDATE') THEN
    RAISE EXCEPTION 'unexpected UPDATE grants on migration_wiki_pages';
  END IF;
  IF EXISTS (SELECT 1 FROM public.migration_wiki_pages WHERE owner_guild IS NULL AND scope = 'guild') THEN
    RAISE EXCEPTION 'a guild wiki page has no owner guild';
  END IF;
  IF v_bodies AND (pg_get_functiondef('public.gm_purge_guild_data(text)'::regprocedure) ~ 'role <> ''super_admin'''
     OR pg_get_functiondef('public.gm_purge_guild_data(text)'::regprocedure) !~ 'gm_revoke_auth_sessions') THEN
    RAISE EXCEPTION 'guild deletion still deletes server_admin accounts or leaves sessions';
  END IF;
  IF v_bodies AND pg_get_functiondef('public.gm_erase_account(text)'::regprocedure) !~ 'gm_revoke_auth_sessions' THEN
    RAISE EXCEPTION 'GDPR erasure still leaves sessions';
  END IF;
  IF has_function_privilege('authenticated', 'public.gm_revoke_auth_sessions(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'gm_revoke_auth_sessions is callable by browsers';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
             WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.auth_user_id = u.id)
               AND u.raw_app_meta_data ? 'account_id'
               AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(u.raw_app_meta_data->>'account_id'))) THEN
    RAISE EXCEPTION 'an orphan sign-in identity still holds a session';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
