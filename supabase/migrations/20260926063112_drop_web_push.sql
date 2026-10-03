-- 20260926120000_drop_web_push.sql
-- Removes the Web Push server surface. The PWA is being retired entirely: the
-- service worker never had a `fetch` handler and never touched Cache Storage,
-- so once push is gone it provides no offline capability and no caching.
--
-- IRREVERSIBLE (data loss): drops push_subscriptions and player_push_prefs.
-- Row counts at the time of writing: push_subscriptions 7, player_push_prefs 21.
-- These are per-device Web Push endpoints and per-player opt-outs; both are
-- worthless without a send path, and `event-reminders` has contained no push
-- code since Web Push was decommissioned ("all notifications are now routed to
-- Discord exclusively"). No user-authored content is lost.
--
-- `save_push_subscription` was additionally a security defect: it was granted to
-- `anon` and fell back to `coalesce(v_guild, 'ALPHA')` when `auth.uid()` is
-- NULL, allowing unauthenticated cross-tenant push registration. Its EXECUTE
-- grants were already revoked by 20260926080100; this drops it outright.

-- ============================================================================
-- 1. RPCs
-- ============================================================================
-- Dropped before the tables so the dependency order is explicit rather than
-- relying on CASCADE to take them with it.

DROP FUNCTION IF EXISTS public.save_push_subscription(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.gm_get_push_prefs(text);
DROP FUNCTION IF EXISTS public.gm_set_push_prefs(text, text[]);

-- ============================================================================
-- 2. Tables
-- ============================================================================

DROP TABLE IF EXISTS public.push_subscriptions;
DROP TABLE IF EXISTS public.player_push_prefs;

-- ============================================================================
-- 3. PostgREST schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

/* ============================================================================
   NO ROLLBACK. Re-creating the tables is trivial (see
   20260830054835_canonicalize_save_push_subscription_v2.sql and the
   player_push_prefs definition in the canonical schema migration), but the rows
   are gone: every member would have to opt in again from their device, which is
   impossible anyway now that the client-side subscribe path has been deleted.

   Do NOT re-introduce save_push_subscription without removing the
   `coalesce(v_guild, 'ALPHA')` tenant fallback and keeping it off `anon`.
   ============================================================================ */
