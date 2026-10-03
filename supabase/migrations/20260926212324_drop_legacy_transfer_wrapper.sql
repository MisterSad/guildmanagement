-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 — drop the one legacy wrapper that really was one
--
-- `transfer_guild_member(p_uid, p_target_guild, p_pseudo)` was a single SQL
-- statement: `SELECT public.gm_transfer_guild_member($1, $2, $3);`. Identical
-- signature, no added behaviour, no internal check of its own -- the guard
-- lives in the function it calls. Its only caller (members.controller) now
-- names the canonical function directly, and nothing in the database
-- references it (checked: no function body, no trigger).
--
-- `request_guild_transfer` IS NOT DROPPED, and the audit was wrong to list it
-- as a duplicate of `gm_admin_request_transfer`. They authorise different
-- people:
--
--   gm_admin_request_transfer  rejects `role = 'member'` outright -- admins only.
--   request_guild_transfer     allows super_admin OR guild access OR THE PLAYER
--                              THEMSELVES (`a.uid = p_uid OR a.id = p_uid`).
--
-- The second is the player self-service path, and it is what `member-portal`
-- calls when a member asks to move guild. Dropping it, or repointing the portal
-- at the admin function, would have made every player request fail on the
-- member guard. A comment records that below so the next cleanup does not try.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.transfer_guild_member(text, text, text);

COMMENT ON FUNCTION public.request_guild_transfer(text, text) IS
    'Player-initiated guild transfer request, called by the member-portal Edge Function. NOT a legacy duplicate of gm_admin_request_transfer: that one rejects role = ''member'' outright, while this one also authorises the player themselves (a.uid = p_uid OR a.id = p_uid). Repointing the portal at the admin function would break every player request.';

DO $verify$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'transfer_guild_member'
    ) THEN
        RAISE EXCEPTION 'transfer_guild_member is still present';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_transfer_guild_member'
    ) THEN
        RAISE EXCEPTION 'the canonical gm_transfer_guild_member is missing -- the wrapper was the only path';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'request_guild_transfer'
    ) THEN
        RAISE EXCEPTION 'request_guild_transfer was dropped -- it is the player self-service path, not a duplicate';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
