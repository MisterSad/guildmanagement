-- Phase 8 — GDPR (finding H4).
--
-- Before this migration the repository contained zero occurrences of `gdpr`,
-- `consent`, `retention` or `erasure`, and the database had retention only for
-- the short-lived security data: login_throttle (24h), discord_auth_throttle
-- (24h) and the Discord ephemera purge. Everything else was kept forever, and
-- there was no way at all to honour an erasure request.
--
-- This migration adds the two missing mechanisms:
--
--   1. gm_apply_data_retention()  -- the periodic purge, scheduled daily.
--   2. gm_erase_player() / gm_erase_account()  -- Article 17 erasure.
--
-- The retention windows are published in `privacy.html` §4. They are literals in
-- the function body rather than a settings table, per the project's convention
-- that guard-rails live in code and change by migration.
--
-- SAFETY: measured against production before writing this, every window below
-- deletes ZERO rows on its first run (oldest audit log 43 days, oldest name
-- history 70 days, no expired cache entries, no closed guild request older than
-- 90 days). The assertion block at the end of this file re-checks that at apply
-- time and aborts if it is not true, so the mechanism can never go live by
-- silently destroying a backlog nobody looked at.

-- ---------------------------------------------------------------------------
-- 1. The wiki foreign keys, which would have made account deletion impossible
-- ---------------------------------------------------------------------------
-- `migration_wiki_pages` and `migration_wiki_comments` reference accounts with
-- ON DELETE NO ACTION. Every other table that references `accounts` cascades.
-- So `DELETE FROM accounts` for anyone who had ever written a wiki page or a
-- comment would fail on a foreign-key violation -- which is presumably why no
-- deletion path was ever written. SET NULL keeps the page and detaches the
-- author; the author's PSEUDO is a separate column and is anonymised by
-- gm_erase_account() below, because that is the part that identifies a person.

ALTER TABLE public.migration_wiki_pages
  DROP CONSTRAINT IF EXISTS migration_wiki_pages_created_by_account_id_fkey;
ALTER TABLE public.migration_wiki_pages
  ADD CONSTRAINT migration_wiki_pages_created_by_account_id_fkey
  FOREIGN KEY (created_by_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE public.migration_wiki_pages
  DROP CONSTRAINT IF EXISTS migration_wiki_pages_updated_by_account_id_fkey;
ALTER TABLE public.migration_wiki_pages
  ADD CONSTRAINT migration_wiki_pages_updated_by_account_id_fkey
  FOREIGN KEY (updated_by_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE public.migration_wiki_comments
  DROP CONSTRAINT IF EXISTS migration_wiki_comments_author_account_id_fkey;
ALTER TABLE public.migration_wiki_comments
  ADD CONSTRAINT migration_wiki_comments_author_account_id_fkey
  FOREIGN KEY (author_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Retention
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gm_apply_data_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    -- Published in privacy.html §4. Changing a value here is a change to a
    -- published commitment: change the page in the same release.
    c_audit_log_months      constant integer := 12;
    c_name_history_months   constant integer := 12;
    c_closed_request_days   constant integer := 90;

    v_audit        integer;
    v_names        integer;
    v_cache        integer;
    v_handles      integer;
BEGIN
    -- Administrative audit trail. Kept long enough to investigate a disputed
    -- change, not indefinitely. It carries `pseudo` and `uid`.
    DELETE FROM public.system_audit_logs
     WHERE created_at < now() - make_interval(months => c_audit_log_months);
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    -- Pseudonym-change history. Its purpose is to keep statistics attributable
    -- across a rename; a year of renames covers that.
    DELETE FROM public.player_name_history
     WHERE changed_at < now() - make_interval(months => c_name_history_months);
    GET DIAGNOSTICS v_names = ROW_COUNT;

    -- The OCR cache already had an expiry column AND a cleanup function
    -- (gm_cleanup_expired_ocr_cache), but nothing ever called it: no cron job
    -- referenced it, so expired rows accumulated. It holds transcribed player
    -- names, so this is a retention gap and not merely housekeeping.
    DELETE FROM public.ocr_cache WHERE expires_at <= now();
    GET DIAGNOSTICS v_cache = ROW_COUNT;

    -- A guild-creation request carries the requester's Discord handle. An
    -- existing job marks pending requests `expired` after 14 days but never
    -- removed the handle, so it survived forever on a request nobody acted on.
    UPDATE public.guild_creation_requests
       SET discord_handle = NULL
     WHERE discord_handle IS NOT NULL
       AND status <> 'pending'
       AND COALESCE(reviewed_at, created_at) < now() - make_interval(days => c_closed_request_days);
    GET DIAGNOSTICS v_handles = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'audit_logs_deleted', v_audit,
        'name_history_deleted', v_names,
        'ocr_cache_deleted', v_cache,
        'discord_handles_cleared', v_handles,
        'ran_at', now()
    );
END;
$$;

COMMENT ON FUNCTION public.gm_apply_data_retention() IS
'GDPR Art. 5(1)(e) storage limitation. Enforces the retention periods published in privacy.html section 4. Scheduled daily; cron/service_role only.';

-- Maintenance function: the cron and service_role call it, nobody else. This is
-- the same posture applied to the other maintenance functions in
-- 20260926080100_revoke_overreaching_function_grants.sql, and it matters more
-- here because this function deletes rows.
REVOKE ALL ON FUNCTION public.gm_apply_data_retention() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gm_apply_data_retention() FROM anon;
REVOKE ALL ON FUNCTION public.gm_apply_data_retention() FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. Erasure — Article 17
-- ---------------------------------------------------------------------------
-- The first version of this function was WRONG, and testing it on the DEMO
-- tenant is what showed it. It deleted the roster row and then tried to
-- anonymise the statistics -- and the anonymisation matched zero rows every
-- time, because seven tables declare
--
--     FOREIGN KEY (guild, pseudo) REFERENCES guild_members(guild, pseudo)
--         ON UPDATE CASCADE ON DELETE CASCADE
--
-- (event_participants, event_daily_scores, player_metrics_history, weekly_scores,
-- sanctions, shadowfront_signups, shadowfront_squads). Deleting the roster row
-- had already cascaded all of them away. The statistics the Policy promises to
-- keep in anonymised form were simply gone, and the function still reported
-- success.
--
-- The schema was telling us the right design. `ON UPDATE CASCADE` means renaming
-- the pseudonym on `guild_members` propagates it to all seven children in one
-- atomic statement. So erasure is an UPDATE, not a DELETE:
--
--   * `guild_members.pseudo` becomes a token from a per-erasure random salt that
--     is never stored, and `uid`, `timezone` and `timezone_offset` are cleared.
--     The row survives as an unattributable placeholder, which is what keeps the
--     seven child tables valid and the guild's historical totals unchanged.
--   * Rows NOT under that foreign key -- absences, pseudonym history, transfers
--     -- are keyed by uid and are deleted outright.
--   * Ban records are deliberately KEPT INTACT. A ban list exists to stop a
--     specific player rejoining, which needs the identifier; Art. 17(3) and the
--     overriding-legitimate-grounds test in Art. 17(1)(c) cover it, and
--     privacy.html section 6.4 discloses it rather than hiding a carve-out.
--
-- Full destruction of the history is a different operation and already exists:
-- removing the member from the roster cascades everything away. That is the
-- guild's own moderation action, not an Art. 17 response, and it is why the
-- Terms' old claim about cascades was half-true -- there IS a cascade, but from
-- `guild_members`, never from `accounts`.

CREATE OR REPLACE FUNCTION public.gm_erase_player(p_guild text, p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_pseudo     text;
    v_token      text;
    v_roster     integer := 0;
    v_absences   integer := 0;
    v_names      integer := 0;
    v_transfers  integer := 0;
    v_audit      integer := 0;
    v_cascaded   integer := 0;
BEGIN
    IF p_guild IS NULL OR btrim(p_guild) = '' OR p_uid IS NULL OR btrim(p_uid) = '' THEN
        RAISE EXCEPTION 'gm_erase_player: guild and uid are both required';
    END IF;

    -- Authorisation is the SAME check that governs every other write to this
    -- tenant, rather than a new rule invented for this path.
    IF NOT public.check_user_guild_write_access(p_guild) THEN
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

    -- How many rows the rename is about to carry with it, counted BEFORE the
    -- update so the report is not measured against the new name.
    SELECT (SELECT count(*) FROM public.event_participants     WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.event_daily_scores     WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.weekly_scores          WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.player_metrics_history WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.sanctions              WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.shadowfront_signups    WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.shadowfront_squads     WHERE guild = p_guild AND pseudo = v_pseudo)
      INTO v_cascaded;

    -- A per-erasure random salt, never stored. Two erasures of the same
    -- pseudonym yield different tokens, so tokens cannot be compared to
    -- re-identify anyone either.
    v_token := 'erased_' || substr(encode(extensions.digest(v_pseudo || gen_random_uuid()::text, 'sha256'), 'hex'), 1, 12);

    -- The whole erasure of identity, in one statement. ON UPDATE CASCADE carries
    -- the token into all seven child tables; `uid` and the timezone columns are
    -- cleared because a timezone narrows down where someone lives.
    UPDATE public.guild_members
       SET pseudo = v_token, uid = NULL, timezone = NULL, timezone_offset = NULL
     WHERE guild = p_guild AND uid = p_uid;
    GET DIAGNOSTICS v_roster = ROW_COUNT;

    -- Not under the (guild, pseudo) foreign key, so these do not follow the
    -- rename and are removed outright.
    DELETE FROM public.player_absences
     WHERE guild = p_guild AND (uid = p_uid OR pseudo = v_pseudo);
    GET DIAGNOSTICS v_absences = ROW_COUNT;

    DELETE FROM public.player_name_history WHERE guild = p_guild AND uid = p_uid;
    GET DIAGNOSTICS v_names = ROW_COUNT;

    -- guild_transfers has no `guild` column: a transfer spans two tenants, so it
    -- is keyed by source_guild/target_guild. Matching either side erases the
    -- trail whichever direction it went.
    DELETE FROM public.guild_transfers
     WHERE uid = p_uid AND (source_guild = p_guild OR target_guild = p_guild);
    GET DIAGNOSTICS v_transfers = ROW_COUNT;

    -- The audit trail records who did what. Anonymise the subject but keep the
    -- entry: an accountability log its own subject can empty is not one.
    UPDATE public.system_audit_logs
       SET pseudo = v_token, uid = NULL
     WHERE guild = p_guild AND (uid = p_uid OR pseudo = v_pseudo);
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    -- The erasure itself is logged WITHOUT the erased identifiers -- recording
    -- the pseudonym here would defeat the entire operation.
    INSERT INTO public.system_audit_logs (level, service, message, guild, metadata)
    VALUES ('INFO', 'gdpr', 'Player data erased under GDPR Art. 17', p_guild,
            jsonb_build_object('token', v_token, 'rows_carried_by_cascade', v_cascaded));

    RETURN jsonb_build_object(
        'ok', true,
        'token', v_token,
        'anonymised', jsonb_build_object(
            'guild_members', v_roster,
            'rows_carried_by_cascade', v_cascaded,
            'system_audit_logs', v_audit),
        'deleted', jsonb_build_object(
            'player_absences', v_absences,
            'player_name_history', v_names,
            'guild_transfers', v_transfers),
        'retained', jsonb_build_object(
            'banned_players', 'kept intact -- Art. 17(3), disclosed in privacy.html section 6.4')
    );
END;
$$;

COMMENT ON FUNCTION public.gm_erase_player(text, text) IS
'GDPR Art. 17 erasure for a player. Renames the roster row to a token from a discarded per-erasure salt, which ON UPDATE CASCADE propagates to the seven (guild, pseudo) child tables, so statistics survive de-identified. Deletes absences, pseudonym history and transfers. Ban records deliberately retained under Art. 17(3). Authorised by check_user_guild_write_access.';

CREATE OR REPLACE FUNCTION public.gm_erase_account(p_account_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guild   text;
    v_role    text;
    v_token   text;
    v_pages   integer := 0;
    v_comm    integer := 0;
BEGIN
    IF p_account_id IS NULL OR btrim(p_account_id) = '' THEN
        RAISE EXCEPTION 'gm_erase_account: account id is required';
    END IF;

    SELECT a.guild, a.role INTO v_guild, v_role
      FROM public.accounts a WHERE a.id = p_account_id;

    IF v_guild IS NULL AND v_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
    END IF;

    -- Only a super_admin may erase an account. Deliberately stricter than
    -- `canManageAccount` in admin-accounts, which lets a guild_admin manage
    -- their peers: peer-level deletion of an irreversible kind is not something
    -- to grant by default.
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'gm_erase_account: super_admin only'
          USING ERRCODE = '42501';
    END IF;

    v_token := 'erased_' || substr(encode(extensions.digest(p_account_id || gen_random_uuid()::text, 'sha256'), 'hex'), 1, 12);

    -- The author FKs are SET NULL as of this migration, but the pseudonym
    -- columns beside them are the identifying part and must be overwritten.
    UPDATE public.migration_wiki_pages
       SET created_by_pseudo = CASE WHEN created_by_account_id = p_account_id THEN v_token ELSE created_by_pseudo END,
           updated_by_pseudo = CASE WHEN updated_by_account_id = p_account_id THEN v_token ELSE updated_by_pseudo END
     WHERE created_by_account_id = p_account_id OR updated_by_account_id = p_account_id;
    GET DIAGNOSTICS v_pages = ROW_COUNT;

    UPDATE public.migration_wiki_comments
       SET author_pseudo = v_token
     WHERE author_account_id = p_account_id;
    GET DIAGNOSTICS v_comm = ROW_COUNT;

    -- Cascades take the auth-adjacent rows: account_backup_codes,
    -- account_link_codes, account_passkeys, discord_account_links,
    -- webauthn_challenges. The wiki FKs now SET NULL instead of blocking.
    DELETE FROM public.accounts WHERE id = p_account_id;

    INSERT INTO public.system_audit_logs (level, service, message, guild, metadata)
    VALUES ('INFO', 'gdpr', 'Account erased under GDPR Art. 17', v_guild,
            jsonb_build_object('token', v_token, 'role', v_role));

    RETURN jsonb_build_object('ok', true, 'token', v_token,
                             'wiki_pages_anonymised', v_pages,
                             'wiki_comments_anonymised', v_comm);
END;
$$;

COMMENT ON FUNCTION public.gm_erase_account(text) IS
'GDPR Art. 17 erasure for an account. super_admin only. Deletes the account (auth-adjacent tables cascade) and anonymises the pseudonym columns on wiki pages and comments the account authored.';

REVOKE ALL ON FUNCTION public.gm_erase_player(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gm_erase_player(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.gm_erase_player(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.gm_erase_account(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gm_erase_account(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.gm_erase_account(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Schedule, and prove the first run is harmless
-- ---------------------------------------------------------------------------
-- 04:30, after the 04:00 stale-lock cleanup, and well clear of the 03:00 DEMO
-- reset and the 03:30 empty-guild expiry.
SELECT cron.unschedule('daily-data-retention')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-data-retention');

SELECT cron.schedule('daily-data-retention', '30 4 * * *',
                     $cron$ SELECT public.gm_apply_data_retention(); $cron$);

DO $assert$
DECLARE
    v_audit  integer;
    v_names  integer;
    v_handle integer;
    v_job    integer;
BEGIN
    -- The windows must not be retroactively destructive. If a future edit
    -- shortens one of them past the existing data, this aborts the migration
    -- instead of quietly deleting a backlog.
    SELECT count(*) INTO v_audit  FROM public.system_audit_logs  WHERE created_at < now() - interval '12 months';
    SELECT count(*) INTO v_names  FROM public.player_name_history WHERE changed_at < now() - interval '12 months';
    SELECT count(*) INTO v_handle FROM public.guild_creation_requests
      WHERE discord_handle IS NOT NULL AND status <> 'pending'
        AND COALESCE(reviewed_at, created_at) < now() - interval '90 days';

    IF v_audit > 0 OR v_names > 0 OR v_handle > 0 THEN
        RAISE EXCEPTION
          'Retention windows would delete existing rows on first run (audit=%, names=%, handles=%). Review before applying.',
          v_audit, v_names, v_handle;
    END IF;

    -- The three functions must exist with the expected argument lists, and the
    -- job must be scheduled. A migration that creates a function nobody calls is
    -- the exact failure this project has already hit twice (the OCR cache, and
    -- gm_cleanup_expired_ocr_cache).
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname='gm_apply_data_retention') THEN
        RAISE EXCEPTION 'gm_apply_data_retention was not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname='gm_erase_player') THEN
        RAISE EXCEPTION 'gm_erase_player was not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname='gm_erase_account') THEN
        RAISE EXCEPTION 'gm_erase_account was not created';
    END IF;

    SELECT count(*) INTO v_job FROM cron.job WHERE jobname = 'daily-data-retention' AND active;
    IF v_job <> 1 THEN
        RAISE EXCEPTION 'daily-data-retention is not scheduled (found % active jobs)', v_job;
    END IF;

    -- And the wiki FKs must no longer block an account delete.
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE contype = 'f' AND confrelid = 'public.accounts'::regclass
           AND confdeltype = 'a'
    ) THEN
        RAISE EXCEPTION 'a foreign key to accounts still uses NO ACTION: account deletion would fail';
    END IF;
END;
$assert$;

-- The new RPCs are reachable over PostgREST only once its schema cache is
-- rebuilt. Without this the erasure functions exist in the database and return
-- 404 from the API, which is the quietest possible way to ship a broken feature.
NOTIFY pgrst, 'reload schema';
