-- Deleting a guild left part of it behind.
--
-- gm_delete_guild and gm_expire_empty_guilds each deleted from a hand-written
-- list of tables. Tables with a foreign key to guilds(id) or to
-- guild_members(guild, pseudo) followed by ON DELETE CASCADE, but the tag also
-- lives in columns with NO foreign key, and neither list covered them all:
--
--   banned_players, player_absences, account_link_codes, system_audit_logs
--   -- never deleted;  war_opponents.guild_ref -- left pointing at nothing.
--
-- Measured live on 2026-10-03: the deleted guild CLAW still owned 6 bans,
-- 12 absences and 59 audit lines; OBSIDANSTAR still had a guild_config row.
-- privacy.html promises that rosters, events, scores and statistics are kept
-- "for as long as the guild uses the Service". And gm_rename_guild (ADR-022)
-- must refuse a TAG that still owns rows, or the next guild to take it would
-- inherit them.
--
-- Decision (owner, 2026-10-03): everything the guild owned goes, its audit
-- lines included. The DELETION itself stays on record: one WARN line with
-- guild = NULL and the tag in metadata.deleted_guild, so it neither belongs to
-- a tenant nor blocks the tag from being reused.
--
-- 1. gm_purge_guild_data(p_guild): the one place that knows every table. Not
--    callable over the API.
-- 2. gm_delete_guild and gm_expire_empty_guilds both call it. Their other
--    behaviour is unchanged.
-- 3. A one-off cleanup of the rows already orphaned, with the counts asserted
--    so the migration aborts if production differs from what was reviewed.

-- ── 0. Drift guards ─────────────────────────────────────────────────────────

DO $$
BEGIN
    IF position('DELETE FROM public.accounts WHERE guild = trim(p_guild_id)' IN
                pg_get_functiondef('public.gm_delete_guild(text)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'gm_delete_guild has drifted from the definition this migration was written against';
    END IF;
    IF position('''Empty guild deleted after the grace period''' IN
                pg_get_functiondef('public.gm_expire_empty_guilds()'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'gm_expire_empty_guilds has drifted from the definition this migration was written against';
    END IF;
END;
$$;

-- ── 1. gm_purge_guild_data ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_purge_guild_data(p_guild text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_guild  text := nullif(btrim(p_guild), '');
    v_counts jsonb := '{}'::jsonb;
    v_n      int;
BEGIN
    IF v_guild IS NULL THEN
        RAISE EXCEPTION 'gm_purge_guild_data: missing guild';
    END IF;

    -- Every tag-carrying column WITHOUT a foreign key to guilds(id). Keep this
    -- list in step with gm_rename_guild (ADR-022);
    -- tests/guild_purge_migration.test.js checks it against the generated types.

    -- The roster first: its (guild, pseudo) cascade removes participations,
    -- scores, metrics, sanctions, squads and sign-ups.
    DELETE FROM public.guild_members WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('guild_members', v_n);

    DELETE FROM public.accounts WHERE guild = v_guild AND (role IS NULL OR role <> 'super_admin');
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('accounts', v_n);

    DELETE FROM public.account_link_codes WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('account_link_codes', v_n);

    DELETE FROM public.banned_players WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('banned_players', v_n);

    DELETE FROM public.event_status WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('event_status', v_n);

    DELETE FROM public.guild_config WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('guild_config', v_n);

    DELETE FROM public.player_absences WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('player_absences', v_n);

    DELETE FROM public.system_audit_logs WHERE guild = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('system_audit_logs', v_n);

    -- Another guild's opponent catalogue keeps the opponent by name; only the
    -- link to a tenant that no longer exists is cleared.
    UPDATE public.war_opponents SET guild_ref = NULL WHERE guild_ref = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('war_opponents_guild_ref', v_n);

    -- The one FK to guilds(id) that is ON DELETE NO ACTION: a comment on a
    -- SERVER-wide wiki page, written by an officer of this guild. It would
    -- block the delete outright. The comment belongs to the server's wiki, so
    -- it stays; only its author's guild is cleared.
    UPDATE public.migration_wiki_comments SET author_guild_id = NULL WHERE author_guild_id = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('wiki_comments_detached', v_n);

    -- Everything else with a foreign key to guilds(id) goes by ON DELETE CASCADE.
    DELETE FROM public.guilds WHERE id = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('guilds', v_n);

    RETURN v_counts;
END;
$function$;

COMMENT ON FUNCTION public.gm_purge_guild_data(text) IS
'Deletes a guild and every row carrying its tag, the non-FK columns included, and returns the counts. Internal: called by gm_delete_guild and gm_expire_empty_guilds, which own the authorisation. Never granted to an API role.';

REVOKE ALL ON FUNCTION public.gm_purge_guild_data(text) FROM PUBLIC, anon, authenticated;

-- ── 2. gm_delete_guild ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_delete_guild(p_guild_id text)
 RETURNS TABLE(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild     text := trim(p_guild_id);
    v_counts    jsonb;
    v_caller_id text;
BEGIN
  IF p_guild_id IS NULL OR trim(p_guild_id) = '' THEN
    RETURN QUERY SELECT false, 'missing_guild_id';
    RETURN;
  END IF;

  -- Security check: only super_admin can delete a tenant/guild
  IF NOT public.is_super_admin() THEN
    RETURN QUERY SELECT false, 'unauthorized';
    RETURN;
  END IF;

  -- Check if guild exists
  IF NOT EXISTS (SELECT 1 FROM public.guilds WHERE id = v_guild) THEN
    RETURN QUERY SELECT false, 'guild_not_found';
    RETURN;
  END IF;

  SELECT a.id INTO v_caller_id
  FROM public.accounts a WHERE a.auth_user_id = auth.uid() LIMIT 1;

  -- Delete all associated tenant data atomically.
  v_counts := public.gm_purge_guild_data(v_guild);

  -- The deletion stays on record, detached from any tenant (guild NULL) so the
  -- tag can be reused without inheriting it.
  INSERT INTO public.system_audit_logs (level, service, action_type, user_identifier, message, metadata)
  VALUES ('WARN', 'gm_delete_guild', 'guild_deleted', COALESCE(v_caller_id, 'super_admin'),
          'Guild ' || v_guild || ' deleted by a super admin',
          jsonb_build_object('deleted_guild', v_guild, 'rows', v_counts));

  RETURN QUERY SELECT true, null::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_delete_guild(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_delete_guild(text) TO authenticated;

-- ── 3. gm_expire_empty_guilds ───────────────────────────────────────────────
-- Unchanged apart from the purge call and the audit line's guild column.

CREATE OR REPLACE FUNCTION public.gm_expire_empty_guilds()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_mark_after   CONSTANT integer := 14;
    v_grace        CONSTANT integer := 14;
    v_protected    CONSTANT text[] := ARRAY['DEMO'];
    -- NO RETROACTIVE DELETION. Three guilds were already memberless when this
    -- shipped. A retention rule must not reach back and destroy tenants
    -- created before it existed, so deletion applies only from the policy date
    -- onward. Older ones are still MARKED: `empty_since` surfaces them for a
    -- human to judge, and the admin screen deletes properly via gm_delete_guild.
    v_policy_start CONSTANT timestamptz := timestamptz '2026-09-26 00:00:00+00';
    v_marked  int := 0;
    v_cleared int := 0;
    v_deleted int := 0;
    v_counts  jsonb;
    g         record;
BEGIN
    UPDATE public.guilds gu SET empty_since = NULL
    WHERE gu.empty_since IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id);
    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    UPDATE public.guilds gu SET empty_since = now()
    WHERE gu.empty_since IS NULL
      AND NOT (gu.id = ANY (v_protected))
      AND gu.created_at < now() - make_interval(days => v_mark_after)
      AND NOT EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id);
    GET DIAGNOSTICS v_marked = ROW_COUNT;

    FOR g IN
        SELECT gu.id FROM public.guilds gu
        WHERE gu.empty_since IS NOT NULL
          AND gu.empty_since < now() - make_interval(days => v_grace)
          AND gu.created_at >= v_policy_start
          AND NOT (gu.id = ANY (v_protected))
          AND NOT EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id)
          AND NOT EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.guild = gu.id)
    LOOP
        v_counts := public.gm_purge_guild_data(g.id);
        v_deleted := v_deleted + 1;

        -- guild NULL: the record of the expiry must not keep the tag owned.
        INSERT INTO public.system_audit_logs (level, service, action_type, guild, message, metadata)
        VALUES ('WARN', 'gm_expire_empty_guilds', 'guild_expired', NULL,
                'Empty guild ' || g.id || ' deleted after the grace period',
                jsonb_build_object('deleted_guild', g.id, 'mark_after_days', v_mark_after,
                                   'grace_days', v_grace, 'rows', v_counts));
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'marked', v_marked, 'cleared', v_cleared, 'deleted', v_deleted);
END;
$function$;

-- A maintenance function: run by pg_cron as postgres, never over the API.
REVOKE ALL ON FUNCTION public.gm_expire_empty_guilds() FROM PUBLIC, anon, authenticated;

-- ── 4. One-off cleanup of the rows already orphaned ─────────────────────────
-- Reviewed with the owner on 2026-10-03: CLAW 6 bans + 12 absences + 59 audit
-- lines, OBSIDANSTAR 1 config row. An empty-string guild on 2 audit lines is
-- not a tenant and is left alone. The counts are asserted: anything else, and
-- the migration aborts rather than delete rows nobody looked at.

DO $$
DECLARE
    v_bans int; v_abs int; v_logs int; v_cfg int; v_other int;
BEGIN
    SELECT count(*) INTO v_other FROM (
        SELECT guild FROM public.accounts           WHERE guild IS NOT NULL AND guild <> '' UNION ALL
        SELECT guild FROM public.account_link_codes WHERE guild IS NOT NULL AND guild <> '' UNION ALL
        SELECT guild FROM public.event_status       UNION ALL
        SELECT guild FROM public.guild_members      UNION ALL
        SELECT guild_ref FROM public.war_opponents  WHERE guild_ref IS NOT NULL
    ) x WHERE x.guild NOT IN (SELECT id FROM public.guilds);

    DELETE FROM public.banned_players  WHERE guild <> '' AND guild NOT IN (SELECT id FROM public.guilds);
    GET DIAGNOSTICS v_bans = ROW_COUNT;
    DELETE FROM public.player_absences WHERE guild <> '' AND guild NOT IN (SELECT id FROM public.guilds);
    GET DIAGNOSTICS v_abs = ROW_COUNT;
    DELETE FROM public.system_audit_logs WHERE guild IS NOT NULL AND guild <> '' AND guild NOT IN (SELECT id FROM public.guilds);
    GET DIAGNOSTICS v_logs = ROW_COUNT;
    DELETE FROM public.guild_config    WHERE guild <> '' AND guild NOT IN (SELECT id FROM public.guilds);
    GET DIAGNOSTICS v_cfg = ROW_COUNT;

    IF v_other <> 0 OR v_bans <> 6 OR v_abs <> 12 OR v_logs <> 59 OR v_cfg <> 1 THEN
        RAISE EXCEPTION 'guild orphan cleanup: expected 6/12/59/1 and 0 elsewhere, found %/%/%/% and % elsewhere -- review before deleting',
            v_bans, v_abs, v_logs, v_cfg, v_other;
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
