-- ═══════════════════════════════════════════════════════════════════════════
-- Phase D4 — self-serve onboarding: join a guild, or create one
--
-- A first Discord sign-in with no linked account now has two ways forward
-- instead of a dead end: redeem a guild's join code, or create a guild.
--
-- GUARDRAILS ARE CONSTANTS HERE, NOT SETTINGS. The owner chose code over a
-- settings table, so changing one is a migration with a diff and a review,
-- not a value someone can quietly raise in a dashboard at 2am.
--
-- THE ACCOUNT-AGE CHECK IS RECOMPUTED IN SQL. The Edge Function can decode a
-- snowflake too, but a value computed there is a value the caller could
-- influence by ordering or by a stale deploy. `gm_snowflake_created_at` below
-- is the authority, and `gm_discord_create_guild` calls it itself.
--
-- THE JOIN PATH KEEPS `status = 'pending'`. That is the existing product rule
-- for player self-registration, and it exists for a good reason: the join code
-- is a shared secret and the UID check only proves the UID is in the roster
-- and unclaimed, not that it belongs to the person typing. An admin still
-- approves. Discord does not change that calculus.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Guardrails ────────────────────────────────────────────────────────────
-- Minimum Discord account age to create a guild. Throwaway accounts are the
-- cheapest way to squat tags.
--   MIN_DISCORD_ACCOUNT_AGE_DAYS = 30
-- Global ceiling on guild creations in any 24 hours, so an automated run
-- cannot exhaust the tag namespace before anyone notices.
--   MAX_GUILD_CREATIONS_PER_DAY = 10
-- An empty guild is marked after this long, then deleted this long after the
-- mark. Fourteen and fourteen: a month of total grace.
--   EMPTY_GUILD_MARK_AFTER_DAYS = 14, EMPTY_GUILD_GRACE_DAYS = 14

ALTER TABLE public.guilds
    ADD COLUMN IF NOT EXISTS empty_since timestamptz;

COMMENT ON COLUMN public.guilds.empty_since IS
    'Set by gm_expire_empty_guilds when a guild has had no members for long enough; cleared the moment it gains one. Deletion happens only after a further grace period, so this column is the visible warning before anything is destroyed.';

-- ── Snowflake → creation instant, authoritative ───────────────────────────
CREATE OR REPLACE FUNCTION public.gm_snowflake_created_at(p_snowflake text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    -- Discord's epoch: 2015-01-01T00:00:00Z.
    v_epoch CONSTANT bigint := 1420070400000;
    v_ms    bigint;
BEGIN
    -- Anything that is not a plausible snowflake returns NULL rather than an
    -- epoch-0 date, so a malformed id cannot sail through an age check.
    IF p_snowflake IS NULL OR p_snowflake !~ '^[0-9]{17,20}$' THEN
        RETURN NULL;
    END IF;
    v_ms := (p_snowflake::numeric / 4194304)::bigint + v_epoch;  -- >> 22
    IF v_ms < v_epoch THEN
        RETURN NULL;
    END IF;
    RETURN to_timestamp(v_ms / 1000.0);
END;
$$;

-- ── Join an existing guild with its join code ─────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_discord_join_guild(
    p_discord_user_id  text,
    p_discord_username text,
    p_join_code        text,
    p_uid              text
)
RETURNS TABLE (ok boolean, account_id text, role text, guild text, status text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guild  text;
    v_new_id text;
    v_server text;
BEGIN
    IF EXISTS (SELECT 1 FROM public.discord_account_links l WHERE l.discord_user_id = p_discord_user_id) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, NULL::text, 'discord_already_linked'::text;
        RETURN;
    END IF;
    IF p_uid IS NULL OR p_uid !~ '^[0-9]{1,20}$' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, NULL::text, 'invalid_uid'::text;
        RETURN;
    END IF;

    -- Same hash shape gm_register_player uses, so one join code works for both
    -- paths for as long as both exist.
    SELECT gc.guild INTO v_guild
    FROM public.guild_config gc
    WHERE gc.key = 'join_code_hash'
      AND gc.value = encode(extensions.digest(upper(trim(p_join_code)), 'sha256'), 'hex')
    LIMIT 1;
    IF v_guild IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, NULL::text, 'invalid_code'::text;
        RETURN;
    END IF;

    -- The UID must already be on that guild's roster: an admin put it there.
    IF NOT EXISTS (SELECT 1 FROM public.guild_members gm WHERE gm.guild = v_guild AND gm.uid = p_uid) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, NULL::text, 'uid_not_in_guild'::text;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounts a WHERE a.uid = p_uid) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, NULL::text, 'uid_already_claimed'::text;
        RETURN;
    END IF;

    SELECT g.server_number INTO v_server FROM public.guilds g WHERE g.id = v_guild;
    v_new_id := public.gm_generate_account_id(p_discord_username);

    -- 'pending' deliberately: see the header. No password column is written.
    INSERT INTO public.accounts (id, role, guild, server_number, uid, status)
    VALUES (v_new_id, 'member', v_guild, v_server, p_uid, 'pending');

    INSERT INTO public.discord_account_links (discord_user_id, account_id)
    VALUES (p_discord_user_id, v_new_id);

    RETURN QUERY SELECT true, v_new_id, 'member'::text, v_guild, 'pending'::text, NULL::text;
END;
$$;

-- ── Create a guild ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_discord_create_guild(
    p_discord_user_id  text,
    p_discord_username text,
    p_guild_tag        text,
    p_server_number    text
)
RETURNS TABLE (ok boolean, account_id text, role text, guild text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_min_age_days CONSTANT integer := 30;
    v_max_per_day  CONSTANT integer := 10;
    v_tag          text := upper(trim(p_guild_tag));
    v_server       text := trim(p_server_number);
    v_created      timestamptz;
    v_today_count  integer;
    v_new_id       text;
BEGIN
    IF EXISTS (SELECT 1 FROM public.discord_account_links l WHERE l.discord_user_id = p_discord_user_id) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'discord_already_linked'::text;
        RETURN;
    END IF;

    -- Same shapes gm_submit_guild_request enforces, so the self-serve and
    -- reviewed paths cannot disagree about what a valid tag is.
    IF v_tag IS NULL OR v_tag !~ '^[A-Z0-9_]{2,12}$' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'invalid_guild_tag'::text;
        RETURN;
    END IF;
    IF v_server IS NULL OR v_server !~ '^[0-9]{4}$' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'invalid_server_number'::text;
        RETURN;
    END IF;

    -- Recomputed HERE, not trusted from the caller.
    v_created := public.gm_snowflake_created_at(p_discord_user_id);
    IF v_created IS NULL OR v_created > now() - make_interval(days => v_min_age_days) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'discord_account_too_new'::text;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.guilds g WHERE upper(g.id) = v_tag) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'tag_taken'::text;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.guild_creation_requests r WHERE upper(r.guild_tag) = v_tag AND r.status = 'pending') THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'tag_taken'::text;
        RETURN;
    END IF;

    SELECT count(*)::int INTO v_today_count
    FROM public.guilds g
    WHERE g.created_at > now() - interval '24 hours';
    IF v_today_count >= v_max_per_day THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text, 'daily_limit_reached'::text;
        RETURN;
    END IF;

    INSERT INTO public.guilds (id, server_number) VALUES (v_tag, v_server);

    v_new_id := public.gm_generate_account_id(p_discord_username);

    -- guild_admin, and no password column written: Discord-only from birth.
    INSERT INTO public.accounts (id, role, guild, server_number, status)
    VALUES (v_new_id, 'guild_admin', v_tag, v_server, 'active');

    INSERT INTO public.discord_account_links (discord_user_id, account_id)
    VALUES (p_discord_user_id, v_new_id);

    RETURN QUERY SELECT true, v_new_id, 'guild_admin'::text, v_tag, NULL::text;
END;
$$;

-- ── Expire empty guilds ───────────────────────────────────────────────────
--
-- CORRECTION TO THE ROADMAP'S PREMISE, established by probing production.
-- The plan warned that `accounts.guild` is `ON DELETE SET NULL`, so that a
-- bare `DELETE FROM guilds` would violate `guild_admin_must_have_guild` and
-- abort the whole nightly transaction. That is NOT what happens:
-- **`public.accounts` has no foreign key at all** — not to `guilds`, not to
-- anything. A naive delete was run against a seeded guild_admin in a
-- rolled-back transaction and it SUCCEEDED.
--
-- The real hazard is quieter and worse: the delete leaves accounts pointing at
-- a guild that no longer exists. No error, no log, just a `guild_admin` whose
-- tenant is gone — and `canWriteGuild` and every RLS helper that reads
-- `accounts.guild` would then be scoping to a dangling name.
--
-- So accounts are still deleted before the guild, but for the opposite reason:
-- not to avoid an exception, but to avoid silence. The deletion set mirrors
-- `gm_delete_guild`, the RPC the admin UI already uses, including its refusal
-- to remove a `super_admin`. Verified: zero orphaned accounts exist today.
CREATE OR REPLACE FUNCTION public.gm_expire_empty_guilds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mark_after  CONSTANT integer := 14;
    v_grace       CONSTANT integer := 14;
    -- Never touched, whatever their state. DEMO is reset nightly by design.
    v_protected   CONSTANT text[] := ARRAY['DEMO'];
    -- NO RETROACTIVE DELETION. Three guilds were already memberless when this
    -- shipped -- GRIM (2026-08-31), RRDR (2026-09-10), DAWN (2026-09-23), one
    -- account each. A retention rule must not reach back and destroy tenants
    -- created before it existed, so deletion applies only to guilds created
    -- from the policy date onward. Older ones are still MARKED, which is the
    -- point: `empty_since` surfaces them for a human to judge, and the admin
    -- screen already deletes a guild properly via gm_delete_guild.
    v_policy_start CONSTANT timestamptz := timestamptz '2026-09-26 00:00:00+00';
    v_marked      int := 0;
    v_cleared     int := 0;
    v_deleted     int := 0;
    g             record;
BEGIN
    -- 1. Clear the mark on any guild that has gained a member.
    UPDATE public.guilds gu
    SET empty_since = NULL
    WHERE gu.empty_since IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id);
    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    -- 2. Mark guilds that have been memberless since creation, long enough.
    UPDATE public.guilds gu
    SET empty_since = now()
    WHERE gu.empty_since IS NULL
      AND NOT (gu.id = ANY (v_protected))
      AND gu.created_at < now() - make_interval(days => v_mark_after)
      AND NOT EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id);
    GET DIAGNOSTICS v_marked = ROW_COUNT;

    -- 3. Delete those still empty after the grace period.
    FOR g IN
        SELECT gu.id
        FROM public.guilds gu
        WHERE gu.empty_since IS NOT NULL
          AND gu.empty_since < now() - make_interval(days => v_grace)
          AND gu.created_at >= v_policy_start
          AND NOT (gu.id = ANY (v_protected))
          AND NOT EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id)
          -- Belt and braces: a guild that ever recorded event activity is not
          -- an abandoned shell, whatever its roster says today.
          AND NOT EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.guild = gu.id)
    LOOP
        -- Same order and the same set as gm_delete_guild, so a guild removed
        -- by the cron and one removed from the admin screen leave the database
        -- in the same state. A super_admin is never deleted along with a
        -- tenant: they are not scoped to it in any meaningful sense.
        DELETE FROM public.event_status      e WHERE e.guild = g.id;
        DELETE FROM public.shadowfront_squads sq WHERE sq.guild = g.id;
        DELETE FROM public.guild_transfers   tr WHERE tr.source_guild = g.id OR tr.target_guild = g.id;
        DELETE FROM public.guild_config      c WHERE c.guild = g.id;
        DELETE FROM public.guild_members     m WHERE m.guild = g.id;
        DELETE FROM public.accounts          a WHERE a.guild = g.id AND (a.role IS NULL OR a.role <> 'super_admin');
        DELETE FROM public.guilds            gu WHERE gu.id = g.id;
        v_deleted := v_deleted + 1;

        INSERT INTO public.system_audit_logs (level, service, action_type, guild, message, metadata)
        VALUES ('WARN', 'gm_expire_empty_guilds', 'guild_expired', g.id,
                'Empty guild deleted after the grace period',
                jsonb_build_object('mark_after_days', v_mark_after, 'grace_days', v_grace));
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true, 'marked', v_marked, 'cleared', v_cleared, 'deleted', v_deleted
    );
END;
$$;

-- ── service_role only ─────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.gm_snowflake_created_at(text)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_discord_join_guild(text, text, text, text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_discord_create_guild(text, text, text, text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_expire_empty_guilds()                             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_snowflake_created_at(text)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_discord_join_guild(text, text, text, text)        TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_discord_create_guild(text, text, text, text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_expire_empty_guilds()                             TO service_role;

-- 03:30, after the 03:00 DEMO reset so the two never contend for the same rows.
SELECT cron.unschedule('daily-expire-empty-guilds')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-expire-empty-guilds');

SELECT cron.schedule(
    'daily-expire-empty-guilds',
    '30 3 * * *',
    $cron$ SELECT public.gm_expire_empty_guilds(); $cron$
);

-- ── Assertions ────────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n   int;
    v_def text;
BEGIN
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_snowflake_created_at', 'gm_discord_join_guild', 'gm_discord_create_guild', 'gm_expire_empty_guilds')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_n <> 0 THEN RAISE EXCEPTION '% onboarding function(s) still executable by anon/authenticated', v_n; END IF;

    -- Neither onboarding path may ever write a password.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_discord_join_guild', 'gm_discord_create_guild')
      AND pg_get_functiondef(p.oid) ~ '(password_hash|password_enc)';
    IF v_n <> 0 THEN RAISE EXCEPTION 'an onboarding path writes a password column'; END IF;

    -- The age check must be recomputed here, not trusted from the caller.
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_discord_create_guild';
    IF v_def !~ 'gm_snowflake_created_at' THEN
        RAISE EXCEPTION 'gm_discord_create_guild must recompute the account age in SQL';
    END IF;

    -- Accounts must be deleted before the guild -- not to avoid an exception
    -- (there is no FK to raise one) but to avoid leaving accounts pointing at
    -- a tenant that no longer exists.
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_expire_empty_guilds';
    IF position('DELETE FROM public.accounts' IN v_def) = 0
       OR position('DELETE FROM public.accounts' IN v_def) > position('DELETE FROM public.guilds            gu WHERE gu.id = g.id' IN v_def) THEN
        RAISE EXCEPTION 'gm_expire_empty_guilds must delete accounts BEFORE the guild';
    END IF;
    IF v_def !~ 'super_admin' THEN
        RAISE EXCEPTION 'gm_expire_empty_guilds must never delete a super_admin';
    END IF;
    IF v_def !~ 'v_policy_start' THEN
        RAISE EXCEPTION 'gm_expire_empty_guilds must not delete guilds created before the policy';
    END IF;
    IF v_def !~ 'DEMO' THEN
        RAISE EXCEPTION 'gm_expire_empty_guilds must protect DEMO';
    END IF;

    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'daily-expire-empty-guilds';
    IF v_n <> 1 THEN RAISE EXCEPTION 'empty-guild expiry not scheduled'; END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
