-- Renaming a guild's TAG after creation.
--
-- In game a guild can change its tag; in the app it could not, so a renamed
-- guild had to ask for its tenant to be deleted and recreated. The tag IS the
-- tenant key: `guilds.id` is the primary key, and 28 columns across 25 tables
-- carry it (measured live on 2026-10-03, information_schema.columns).
--
-- Those columns fall in three groups, and each needs a different mechanism:
--
--   1. 14 foreign keys to guilds(id). Only guild_weekly_snapshots cascaded an
--      update; the other 13 were ON UPDATE NO ACTION. They now ALL cascade.
--   2. 7 composite foreign keys (guild, pseudo) -> guild_members, already
--      ON UPDATE CASCADE. guild_members.guild itself has NO foreign key to
--      guilds, so it is updated explicitly and the cascade carries the rest.
--   3. 9 columns with no foreign key at all (accounts, guild_config, ...),
--      updated explicitly by the RPC.
--
-- Groups 1 and 2 overlap: player_metrics_history and event_daily_scores carry
-- BOTH a (guild) -> guilds FK and a (guild, pseudo) -> guild_members FK. Whichever
-- parent moves first, the child row transiently points at a parent that does not
-- exist yet. Tag-carrying FKs are therefore made DEFERRABLE INITIALLY IMMEDIATE:
-- every normal statement still checks them immediately, and only
-- gm_rename_guild defers them, for the length of its own transaction. Referential
-- ACTIONS (the cascade itself) are never deferred by Postgres -- only the check.
--
-- Why cascade rather than insert-new / move-children / delete-old: every one of
-- these FKs is ON DELETE CASCADE. A child table missed by an explicit list would
-- be silently wiped by the final DELETE. With ON UPDATE CASCADE, a future FK
-- added without it makes the UPDATE fail loudly instead.

-- ── 1. History table ────────────────────────────────────────────────────────
-- Created before the FK rewrite below, so the loop normalises its FK too.

CREATE TABLE IF NOT EXISTS public.guild_tag_history (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild       text NOT NULL REFERENCES public.guilds(id) ON UPDATE CASCADE ON DELETE CASCADE,
    old_tag     text NOT NULL,
    new_tag     text NOT NULL,
    changed_by  text,
    changed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.guild_tag_history IS
'One row per guild tag change. `guild` follows the guild through later renames (ON UPDATE CASCADE); old_tag / new_tag are frozen text. Read through gm_guild_tag_history, written only by gm_rename_guild. Also drives the 7-day cooldown.';

CREATE INDEX IF NOT EXISTS idx_guild_tag_history_guild
    ON public.guild_tag_history (guild, changed_at DESC);

ALTER TABLE public.guild_tag_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_tag_history FORCE ROW LEVEL SECURITY;

-- Deny-all by construction: zero policies, reachable only through the two
-- SECURITY DEFINER functions below and service_role (finding M4 posture).
REVOKE ALL ON TABLE public.guild_tag_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_tag_history TO service_role;

-- ── 2. Every FK carrying a tag column: DEFERRABLE INITIALLY IMMEDIATE ───────
-- A rename moves parent and child rows in several statements, and in between a
-- child can point at a parent key that has not moved yet. Beyond the overlap
-- described above, a live probe (BEGIN ... ROLLBACK, 2026-10-03) found a third
-- shape: fk_event_daily_scores_session, (guild, event_name, session_id) ->
-- war_sessions, which guild_members' cascade moves before war_sessions moves.
--
-- So every FK whose child columns include a tag column is made deferrable;
-- those referencing guilds(id) also become ON UPDATE CASCADE. All other actions
-- are preserved as found. Rebuilt from the catalogue rather than from a
-- hand-written list, so a constraint the inventory missed cannot be skipped.

DO $$
DECLARE
    r       record;
    v_cols  text;
    v_pcols text;
    v_upd   text;
    v_del   text;
BEGIN
    FOR r IN
        SELECT c.oid, c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey,
               c.confupdtype, c.confdeltype
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.connamespace = 'public'::regnamespace
          AND (
              c.confrelid = 'public.guilds'::regclass
              OR EXISTS (
                  SELECT 1 FROM unnest(c.conkey) k
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
                  WHERE a.attname ~ '^(guild|guild_id|guild_ref|source_guild|target_guild|author_guild_id)$'
              )
          )
          AND (
              NOT c.condeferrable
              OR (c.confrelid = 'public.guilds'::regclass AND c.confupdtype <> 'c')
          )
    LOOP
        SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) INTO v_cols
        FROM unnest(r.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = r.conrelid AND a.attnum = k.attnum;

        SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) INTO v_pcols
        FROM unnest(r.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = r.confrelid AND a.attnum = k.attnum;

        v_upd := CASE
            WHEN r.confrelid = 'public.guilds'::regclass THEN 'CASCADE'
            ELSE CASE r.confupdtype
                WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
                WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END
        END;
        v_del := CASE r.confdeltype
            WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
            WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END;

        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.conrelid::regclass, r.conname);
        EXECUTE format(
            'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %s (%s) '
            'ON UPDATE %s ON DELETE %s DEFERRABLE INITIALLY IMMEDIATE',
            r.conrelid::regclass, r.conname, v_cols, r.confrelid::regclass, v_pcols, v_upd, v_del
        );
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = 'public.guilds'::regclass
          AND (c.confupdtype <> 'c' OR NOT c.condeferrable OR c.condeferred)
    ) OR EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.connamespace = 'public'::regnamespace
          AND (NOT c.condeferrable OR c.condeferred)
          AND EXISTS (
              SELECT 1 FROM unnest(c.conkey) k
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
              WHERE a.attname ~ '^(guild|guild_id|guild_ref|source_guild|target_guild|author_guild_id)$'
          )
    ) THEN
        RAISE EXCEPTION 'guild_rename: a foreign key carrying a guild tag is still not DEFERRABLE INITIALLY IMMEDIATE (or, to guilds, not ON UPDATE CASCADE)';
    END IF;
END;
$$;

-- ── 3. gm_rename_guild ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_rename_guild(p_guild text, p_new_tag text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
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
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
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

    -- DEMO is rebuilt nightly by gm_reset_demo_tenant_data(), keyed by name.
    IF v_old = 'DEMO' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'demo_protected');
    END IF;
    IF v_new = 'DEMO' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tag_reserved');
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

COMMENT ON FUNCTION public.gm_rename_guild(text, text) IS
'Renames a guild tag (guilds.id) and every column that carries it, atomically. super_admin, or guild_admin of the guild. 2-12 chars [A-Z0-9_], case-insensitively unique, never DEMO, never a tag still owning residual rows, 7-day cooldown except for super_admin.';

REVOKE ALL ON FUNCTION public.gm_rename_guild(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_rename_guild(text, text) TO authenticated;

-- ── 4. gm_guild_tag_history ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gm_guild_tag_history(p_guild text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_guild  text := nullif(btrim(p_guild), '');
    v_last   timestamptz;
    v_rows   jsonb;
BEGIN
    IF v_guild IS NULL OR NOT public.check_user_guild_write_access(v_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    SELECT max(h.changed_at) INTO v_last
    FROM public.guild_tag_history h WHERE h.guild = v_guild;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'old_tag', x.old_tag, 'new_tag', x.new_tag, 'changed_at', x.changed_at
           ) ORDER BY x.changed_at DESC), '[]'::jsonb)
      INTO v_rows
    FROM (
        SELECT h.old_tag, h.new_tag, h.changed_at
        FROM public.guild_tag_history h
        WHERE h.guild = v_guild
        ORDER BY h.changed_at DESC
        LIMIT 20
    ) x;

    RETURN jsonb_build_object(
        'ok', true,
        'history', v_rows,
        'next_allowed_at', CASE WHEN v_last IS NULL THEN NULL ELSE v_last + interval '7 days' END
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_guild_tag_history(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_guild_tag_history(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
