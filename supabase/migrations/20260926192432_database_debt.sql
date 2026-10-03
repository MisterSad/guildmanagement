-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 — finding M3: measured database debt
--
-- Four of the six items are fixed here. The other two are DELIBERATELY NOT
-- fixed, and the reasoning is recorded so nobody re-files them as oversights.
--
-- FIXED
--   1. Two pairs of byte-identical indexes on system_audit_logs.
--   2. Three policies re-evaluating auth.uid() per row.
--   3. Three tables running two permissive policies on every SELECT.
--
-- NOT FIXED, ON PURPOSE
--   4. The 12 "unindexed foreign keys". Every child table whose FK points at
--      `guilds` or `accounts` holds between 0 and 8 rows: account_link_codes 0,
--      migration_wiki_comments 0, guild_transfers 3, ocr_cache 8,
--      migration_wiki_pages 8. A sequential scan of 8 rows beats an index
--      lookup, and each index added here is a write cost paid forever.
--      The two larger tables (event_daily_scores 2 436, weekly_scores 300)
--      have COMPOSITE member FKs, not guild/account ones, and are join-only.
--      This is not laziness -- it is the lesson of 20260920140000, which added
--      FK indexes by lint rather than by measurement and whose indexes now make
--      up a large share of the 21 "unused index" findings. The two lints are
--      the same mistake seen from both ends. Index when a query is shown to be
--      slow, not when a linter counts a constraint.
--   5. `pg_net` living in `public`. Its single consumer is
--      gm_invoke_event_reminders, which runs EVERY FIVE MINUTES with
--      `search_path = ''` and therefore calls pg_net fully qualified. Moving the
--      extension means rewriting that function in the same transaction, i.e.
--      risking the production reminder path to silence a cosmetic warning --
--      pg_net's objects already live in the `net` schema, which PostgREST does
--      not expose, so nothing is reachable from the API either way.
--
-- The 21 unused indexes are also left alone: the plan calls for an observation
-- window first, and several sit on tables (account_passkeys,
-- webauthn_challenges, accounts.locked_until) that phase D7 removes outright.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Duplicate indexes ──────────────────────────────────────────────────
-- `idx_audit_logs_created_at_recent` is MINE: 20260926240000 added it with
-- `CREATE INDEX IF NOT EXISTS` under a new name, which cannot detect an
-- existing index with the same definition under a different name. The index it
-- wanted -- (created_at DESC) -- was already there as idx_audit_logs_created_at.
DROP INDEX IF EXISTS public.idx_audit_logs_created_at_recent;

-- Both are (guild, created_at DESC). Keeping the name that describes the
-- columns; `idx_audit_logs_guild` claims a single-column index it never was.
DROP INDEX IF EXISTS public.idx_audit_logs_guild;

-- ── 2. auth.uid() re-evaluated per row ────────────────────────────────────
-- Wrapped in (SELECT ...) so the planner treats it as a one-time InitPlan
-- instead of a correlated expression evaluated for every candidate row.
DROP POLICY IF EXISTS gm_migration_wiki_delete ON public.migration_wiki_pages;
CREATE POLICY gm_migration_wiki_delete ON public.migration_wiki_pages
    FOR DELETE TO authenticated
    USING (
        public.is_super_admin()
        OR (
            created_by_account_id = (
                SELECT a.id FROM public.accounts a
                WHERE a.auth_user_id = (SELECT auth.uid()) AND a.status = 'active'
                LIMIT 1
            )
            AND (
                (scope = 'guild'  AND public.check_user_guild_access(guild_id))
                OR (scope = 'server' AND public.gm_can_access_server_wiki(server_number))
            )
        )
    );

DROP POLICY IF EXISTS gm_migration_wiki_comments_delete ON public.migration_wiki_comments;
CREATE POLICY gm_migration_wiki_comments_delete ON public.migration_wiki_comments
    FOR DELETE TO authenticated
    USING (
        public.is_super_admin()
        OR (
            author_account_id = (
                SELECT a.id FROM public.accounts a
                WHERE a.auth_user_id = (SELECT auth.uid()) AND a.status = 'active'
                LIMIT 1
            )
            AND public.gm_can_access_wiki_page(page_id)
        )
    );

-- ocr_cache: the `guild_id IS NULL` disjunct is ALSO a real defect (audit B3).
-- super_admin and server_admin accounts have accounts.guild = NULL by design,
-- so their cached scans are stored with a NULL guild_id -- and this policy made
-- every such row readable by EVERY authenticated user of EVERY tenant. It reads
-- zero rows today only because the cache has never worked (finding H1); the
-- moment it is repaired, it would leak. Removed here rather than left as a
-- landmine for phase 5.
DROP POLICY IF EXISTS ocr_cache_admin_select ON public.ocr_cache;
CREATE POLICY ocr_cache_admin_select ON public.ocr_cache
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.accounts a
            WHERE a.auth_user_id = (SELECT auth.uid())
              AND a.status = 'active'
              AND (
                    a.role = 'super_admin'
                 -- A scoped row is readable by whoever can read that guild.
                 OR (ocr_cache.guild_id IS NOT NULL AND public.gm_can_read_guild_data(ocr_cache.guild_id))
              )
        )
    );

-- ── 3. Two permissive policies on every SELECT ────────────────────────────
-- Each table had a SELECT policy plus a FOR ALL policy; permissive policies OR
-- together, so both ran on every read. Narrowing the write policy to the write
-- verbs removes the second evaluation.
--
-- Verified safe before applying, across all 172 live accounts: every account
-- that satisfies the WRITE predicate also satisfies the READ one (61/61
-- guild_admin, 1/1 server_admin, 1/1 super_admin; members satisfy neither).
-- Zero accounts would lose read access.
DROP POLICY IF EXISTS player_metrics_history_write ON public.player_metrics_history;
CREATE POLICY player_metrics_history_write ON public.player_metrics_history
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));
CREATE POLICY player_metrics_history_update ON public.player_metrics_history
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));
CREATE POLICY player_metrics_history_delete ON public.player_metrics_history
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_smgs_write ON public.server_migration_group_servers;
CREATE POLICY gm_smgs_write ON public.server_migration_group_servers
    FOR INSERT TO authenticated WITH CHECK (public.is_super_admin());
CREATE POLICY gm_smgs_update ON public.server_migration_group_servers
    FOR UPDATE TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
CREATE POLICY gm_smgs_delete ON public.server_migration_group_servers
    FOR DELETE TO authenticated USING (public.is_super_admin());

DROP POLICY IF EXISTS gm_smg_write ON public.server_migration_groups;
CREATE POLICY gm_smg_write ON public.server_migration_groups
    FOR INSERT TO authenticated WITH CHECK (public.is_super_admin());
CREATE POLICY gm_smg_update ON public.server_migration_groups
    FOR UPDATE TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
CREATE POLICY gm_smg_delete ON public.server_migration_groups
    FOR DELETE TO authenticated USING (public.is_super_admin());

-- ── 4. Assertions ─────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_audit_logs_created_at_recent') THEN
        RAISE EXCEPTION 'the duplicate index this migration introduced is still present';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_audit_logs_created_at') THEN
        RAISE EXCEPTION 'dropped the wrong created_at index -- the survivor is gone';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_audit_logs_guild_created') THEN
        RAISE EXCEPTION 'dropped the wrong guild index -- the survivor is gone';
    END IF;

    -- No table may keep two permissive policies for authenticated/SELECT.
    SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_n
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('player_metrics_history','server_migration_groups','server_migration_group_servers')
      AND cmd = 'ALL';
    IF v_n IS NOT NULL THEN
        RAISE EXCEPTION 'FOR ALL policies still overlapping SELECT: %', v_n;
    END IF;

    -- The ocr_cache cross-tenant disjunct must be gone.
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='ocr_cache' AND policyname='ocr_cache_admin_select'
          AND qual ~ 'guild_id IS NULL'
    ) THEN
        RAISE EXCEPTION 'ocr_cache still grants every tenant the NULL-guild rows';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
