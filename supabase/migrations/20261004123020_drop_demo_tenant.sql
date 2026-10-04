-- Retire the DEMO tenant (owner decision, 2026-10-04).
--
-- Anyone can now create a guild themselves (Continue with Discord -> create a
-- guild), so a shared sandbox no longer earns its keep. It was rebuilt every
-- night at 03:00 by gm_reset_demo_tenant_data(), and three other functions
-- treated it as a special case.
--
-- Owner decisions:
--   * the DEMO guild goes the way every deleted guild goes, through
--     gm_purge_guild_data(): roster (and its cascade), accounts -- the two demo
--     accounts and `bread`, a DEMO guild_admin that never signed in -- config,
--     absences, audit lines, status. Their sessions are revoked; auth.users
--     rows are kept, as for any deleted guild;
--   * the TAG "DEMO" becomes an ordinary TAG: every exception for it goes.
--
-- The three redefined functions are the production bodies verbatim
-- (md5-checked against a replay, 2026-10-04) minus their DEMO lines.

-- ── Production guard ─────────────────────────────────────────────────────────
-- On production, refuse to run unless DEMO is exactly what was measured: its
-- three accounts, none of them platform-wide. A replay builds DEMO from the
-- migrations and is not held to the production account list.
DO $guard$
DECLARE
    v_accounts text;
BEGIN
    IF current_setting('gm.replay', true) = 'on' THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.guilds WHERE id = 'DEMO') THEN
        RAISE EXCEPTION 'drop_demo_tenant: no DEMO guild to remove';
    END IF;
    SELECT string_agg(id || ':' || coalesce(role, '?'), ',' ORDER BY id COLLATE "C") INTO v_accounts
      FROM public.accounts WHERE guild = 'DEMO';
    IF v_accounts IS DISTINCT FROM 'DemoAdmin:guild_admin,DemoPlayer:member,bread:guild_admin' THEN
        RAISE EXCEPTION 'drop_demo_tenant: DEMO accounts are %, not the three measured', v_accounts;
    END IF;
END;
$guard$;

-- ── The nightly rebuild ──────────────────────────────────────────────────────
DO $cron$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-demo-tenant-reset') THEN
        PERFORM cron.unschedule('daily-demo-tenant-reset');
    END IF;
END;
$cron$;

DROP FUNCTION IF EXISTS public.gm_reset_demo_tenant_data();

-- ── The tenant ───────────────────────────────────────────────────────────────
DO $purge$
DECLARE
    v_counts jsonb;
BEGIN
    IF EXISTS (SELECT 1 FROM public.guilds WHERE id = 'DEMO') THEN
        v_counts := public.gm_purge_guild_data('DEMO');
        RAISE NOTICE 'DEMO purged: %', v_counts;
    END IF;
END;
$purge$;

-- ── Functions: no DEMO exception left ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_expire_empty_guilds()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_mark_after   CONSTANT integer := 14;
    v_grace        CONSTANT integer := 14;
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
      AND gu.created_at < now() - make_interval(days => v_mark_after)
      AND NOT EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id);
    GET DIAGNOSTICS v_marked = ROW_COUNT;

    FOR g IN
        SELECT gu.id FROM public.guilds gu
        WHERE gu.empty_since IS NOT NULL
          AND gu.empty_since < now() - make_interval(days => v_grace)
          AND gu.created_at >= v_policy_start
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

CREATE OR REPLACE FUNCTION public.gm_list_opponent_candidates(p_guild text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_target text := TRIM(p_guild);
    v_kind   text := LOWER(TRIM(p_kind));
    v_items  jsonb;
BEGIN
    IF v_kind NOT IN ('server', 'guild') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_kind = 'server' THEN
        WITH cat AS (
            SELECT o.id::text AS id, o.kind AS kind, o.name AS name,
                   o.server_number AS server_number, o.guild_ref AS guild_ref, true AS is_existing
            FROM public.war_opponents o
            WHERE o.guild = v_target AND o.kind = 'server'
        ),
        sug AS (
            SELECT NULL::text AS id, v_kind AS kind, s.server_number AS name,
                   s.server_number AS server_number, NULL::text AS guild_ref, false AS is_existing
            FROM (SELECT DISTINCT g.server_number
                  FROM public.guilds g
                  WHERE g.server_number IS NOT NULL AND g.server_number <> '') s
            WHERE NOT EXISTS (SELECT 1 FROM cat c WHERE LOWER(c.name) = LOWER(s.server_number))
        ),
        merged AS (
            SELECT * FROM cat
            UNION ALL
            SELECT * FROM sug
        )
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name,
                               'server_number', m.server_number, 'guild_ref', m.guild_ref,
                               'is_existing', m.is_existing)
            ORDER BY LOWER(m.name)
        ), '[]'::jsonb) INTO v_items
        FROM merged m;
    ELSE
        WITH cat AS (
            SELECT o.id::text AS id, o.kind AS kind, o.name AS name,
                   o.server_number AS server_number, o.guild_ref AS guild_ref, true AS is_existing
            FROM public.war_opponents o
            WHERE o.guild = v_target AND o.kind = 'guild'
        ),
        sug AS (
            -- This coalesced the guilds table's `name` column with the id.
            -- That column does not exist, so the whole branch answered 42703 and
            -- the picker returned 400. The identifier IS the name here.
            SELECT NULL::text AS id, v_kind AS kind, g.id AS name,
                   g.server_number AS server_number, g.id AS guild_ref, false AS is_existing
            FROM public.guilds g
            WHERE g.id <> v_target
              AND NOT EXISTS (
                  SELECT 1 FROM cat c
                  WHERE LOWER(c.name) = LOWER(g.id)
                     OR c.guild_ref = g.id
              )
        ),
        merged AS (
            SELECT * FROM cat
            UNION ALL
            SELECT * FROM sug
        )
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name,
                               'server_number', m.server_number, 'guild_ref', m.guild_ref,
                               'is_existing', m.is_existing)
            ORDER BY LOWER(m.name)
        ), '[]'::jsonb) INTO v_items
        FROM merged m;
    END IF;

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'kind', v_kind, 'items', v_items);
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_rename_guild(p_guild text, p_new_tag text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_old        text := nullif(btrim(p_guild), '');
    v_new        text := upper(nullif(btrim(p_new_tag), ''));
    v_is_super   boolean;
    v_caller_id  text;
    v_role       text;
    v_last       timestamptz;
    v_cooldown   constant interval := interval '7 days';
BEGIN
    IF v_old IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_not_found');
    END IF;

    -- Authorisation: super_admin anywhere, or a guild_admin of THIS guild.
    -- check_user_guild_write_access also admits a server_admin of the guild's
    -- server; renaming a tenant is deliberately kept from that role.
    v_is_super := public.is_super_admin();
    SELECT a.id, a.role INTO v_caller_id, v_role
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active'
    LIMIT 1;

    IF NOT v_is_super AND NOT (
        v_role = 'guild_admin' AND public.check_user_guild_write_access(v_old)
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- Same shape as guild creation (guild-request / Discord onboarding).
    IF v_new IS NULL OR v_new !~ '^[A-Z0-9_]{2,12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_tag');
    END IF;

    -- Serialises concurrent renames of the same guild.
    PERFORM 1 FROM public.guilds WHERE id = v_old FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_not_found');
    END IF;

    IF v_new = v_old THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unchanged');
    END IF;

    -- Case-insensitive: 'Alpha' must not shadow 'ALPHA'. A case-only change of
    -- this guild's own tag is allowed (id <> v_old).
    IF EXISTS (SELECT 1 FROM public.guilds WHERE upper(id) = v_new AND id <> v_old) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tag_taken');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.guild_creation_requests
        WHERE status = 'pending' AND upper(guild_tag) = v_new
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tag_reserved');
    END IF;

    -- A deleted guild leaves rows behind in tables with no FK to guilds
    -- (gm_delete_guild does not clear them): live on 2026-10-03, the deleted
    -- CLAW still owned 6 bans, 12 absences and 59 audit log lines. Taking that
    -- tag would hand another tenant's data to this one. Refuse instead.
    IF EXISTS (SELECT 1 FROM public.guild_members     WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.accounts          WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.account_link_codes WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.banned_players    WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.event_status      WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.guild_config      WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.player_absences   WHERE guild = v_new)
    OR EXISTS (SELECT 1 FROM public.system_audit_logs WHERE guild = v_new)
    THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tag_reserved');
    END IF;

    SELECT max(h.changed_at) INTO v_last
    FROM public.guild_tag_history h WHERE h.guild = v_old;
    IF NOT v_is_super AND v_last IS NOT NULL AND v_last > now() - v_cooldown THEN
        RETURN jsonb_build_object(
            'ok', false, 'error', 'cooldown',
            'next_allowed_at', v_last + v_cooldown
        );
    END IF;

    -- Only DEFERRABLE constraints are affected: the tag-carrying FKs made so above.
    SET CONSTRAINTS ALL DEFERRED;

    -- guild_members first: its (guild, pseudo) cascade moves the seven child
    -- tables, whose own guilds FK is momentarily unsatisfied (deferred).
    UPDATE public.guild_members SET guild = v_new WHERE guild = v_old;

    -- Cascades to every FK on guilds(id), including guild_tag_history.
    UPDATE public.guilds SET id = v_new, updated_at = now() WHERE id = v_old;

    -- Columns with no foreign key. Keep this list in step with the inventory
    -- in tests/guild_rename_migration.test.js.
    UPDATE public.accounts           SET guild = v_new     WHERE guild = v_old;
    UPDATE public.account_link_codes SET guild = v_new     WHERE guild = v_old;
    UPDATE public.banned_players     SET guild = v_new     WHERE guild = v_old;
    UPDATE public.event_status       SET guild = v_new     WHERE guild = v_old;
    UPDATE public.guild_config       SET guild = v_new     WHERE guild = v_old;
    UPDATE public.player_absences    SET guild = v_new     WHERE guild = v_old;
    UPDATE public.system_audit_logs  SET guild = v_new     WHERE guild = v_old;
    UPDATE public.war_opponents      SET guild_ref = v_new WHERE guild_ref = v_old;

    -- The display tag used in Discord mentions and OCR follows the rename;
    -- it can still be edited separately in Guild settings afterwards.
    INSERT INTO public.guild_config (guild, key, value, updated_at)
    VALUES (v_new, 'guild_tag', '[' || v_new || ']', now())
    ON CONFLICT (guild, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    INSERT INTO public.guild_tag_history (guild, old_tag, new_tag, changed_by)
    VALUES (v_new, v_old, v_new, v_caller_id);

    INSERT INTO public.system_audit_logs (
        level, service, guild, user_identifier, message, metadata, action_type, created_at
    ) VALUES (
        'INFO', 'guild_rename', v_new,
        COALESCE(v_caller_id, auth.uid()::text, 'Admin'),
        'Guild tag changed from ' || v_old || ' to ' || v_new,
        jsonb_build_object('old_tag', v_old, 'new_tag', v_new),
        'guild_rename', now()
    );

    -- Run the deferred checks now, inside the function, so a violation is
    -- raised (and the whole rename rolled back) here rather than at COMMIT.
    SET CONSTRAINTS ALL IMMEDIATE;

    RETURN jsonb_build_object('ok', true, 'guild', v_new, 'old_guild', v_old);
END;
$function$;


-- ── End state ────────────────────────────────────────────────────────────────
DO $check$
BEGIN
    IF EXISTS (SELECT 1 FROM public.guilds WHERE id = 'DEMO') THEN
        RAISE EXCEPTION 'drop_demo_tenant: the DEMO guild is still there';
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounts WHERE guild = 'DEMO') THEN
        RAISE EXCEPTION 'drop_demo_tenant: an account still belongs to DEMO';
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-demo-tenant-reset') THEN
        RAISE EXCEPTION 'drop_demo_tenant: the nightly DEMO rebuild is still scheduled';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
                  AND pg_get_functiondef(p.oid) LIKE '%''DEMO''%') THEN
        RAISE EXCEPTION 'drop_demo_tenant: a function still names the DEMO guild';
    END IF;
END;
$check$;

NOTIFY pgrst, 'reload schema';
