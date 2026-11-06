-- The Migration Hub is retired (owner decision, 2026-11-06): the wiki of
-- migration intel, its comments and its AI summary are removed for good.
--
-- Owner decision: permanent deletion, no export. Measured on production before
-- the drop: 18 pages and 6 comments across 4 guilds.
--
-- NOT the hub, and kept: the cross-server migration groups
-- (server_migration_groups, server_migration_group_servers,
-- servers_in_open_migration_group, gm_create_migration_group), which gate
-- cross-server player transfers.
--
-- Order: the two functions that reach into the wiki are redefined first, so
-- nothing references the tables when they go; then the tables (their policies,
-- triggers, indexes and grants go with them); then the helpers only their
-- policies used. The Edge Function `migration-summary` is removed from the
-- repository in the same change.

-- ── 1. GDPR erasure no longer anonymises wiki authorship ────────────────────

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

    RETURN jsonb_build_object('ok', true, 'token', v_token);
END;
$function$;
REVOKE ALL ON FUNCTION public.gm_erase_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_erase_account(text) TO authenticated, service_role;

-- ── 2. A guild's purge no longer detaches wiki comments ─────────────────────

CREATE OR REPLACE FUNCTION public.gm_purge_guild_data(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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

    PERFORM public.gm_revoke_auth_sessions(a.auth_user_id)
       FROM public.accounts a
      WHERE a.guild = v_guild AND a.auth_user_id IS NOT NULL
        AND (a.role IS NULL OR a.role IN ('guild_admin', 'member'));
    DELETE FROM public.accounts
     WHERE guild = v_guild AND (role IS NULL OR role IN ('guild_admin', 'member'));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('accounts', v_n);
    UPDATE public.accounts a
       SET server_number = COALESCE(a.server_number, (SELECT g.server_number FROM public.guilds g WHERE g.id = v_guild)),
           guild = NULL
     WHERE a.guild = v_guild AND a.role IN ('server_admin', 'super_admin');
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('accounts_detached', v_n);

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

    -- Everything else with a foreign key to guilds(id) goes by ON DELETE CASCADE.
    DELETE FROM public.guilds WHERE id = v_guild;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('guilds', v_n);

    RETURN v_counts;
END;
$function$;
REVOKE ALL ON FUNCTION public.gm_purge_guild_data(p_guild text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gm_purge_guild_data(p_guild text) TO service_role;

-- ── 3. The wiki tables, then the helpers only their policies used ───────────

DROP TABLE IF EXISTS public.migration_wiki_comments;
DROP TABLE IF EXISTS public.migration_wiki_pages;

DROP FUNCTION IF EXISTS public.gm_wiki_comment_stamp();
DROP FUNCTION IF EXISTS public.gm_wiki_page_stamp();
DROP FUNCTION IF EXISTS public.gm_can_access_wiki_page(uuid);
DROP FUNCTION IF EXISTS public.gm_can_access_server_wiki(text);

-- ── 4. Assert the end state ─────────────────────────────────────────────────

DO $check$
DECLARE
    v_name text;
BEGIN
    IF to_regclass('public.migration_wiki_pages') IS NOT NULL
       OR to_regclass('public.migration_wiki_comments') IS NOT NULL THEN
        RAISE EXCEPTION 'a wiki table is still there';
    END IF;
    SELECT p.proname INTO v_name
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (pg_get_functiondef(p.oid) ~ 'migration_wiki' OR p.proname ~ 'wiki')
     LIMIT 1;
    IF v_name IS NOT NULL THEN
        RAISE EXCEPTION '% still refers to the wiki', v_name;
    END IF;
    IF NOT to_regclass('public.server_migration_groups') IS NOT NULL THEN
        RAISE EXCEPTION 'the cross-server migration groups must stay';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
