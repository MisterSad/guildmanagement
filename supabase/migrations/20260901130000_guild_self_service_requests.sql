-- 20260901130000_guild_self_service_requests.sql
--
-- Self-service guild creation, Phase 1 (request + manual validation, no
-- payment — this app is 100% free, see 20260824000000_free_app_and_donations).
-- Today, creating a guild is two manual super_admin-only steps (raw client
-- insert into guilds, then a separate admin-accounts "create" call for the
-- first guild_admin). This migration adds a dedicated pending-request table
-- so anyone can submit a request without being an admin, which a super_admin
-- then reviews and approves/rejects — never automatic, never payment-gated.
--
-- Mirrors the existing player self-registration pattern
-- (gm_register_player, 20260823100000_canonical_reconciliation_round2.sql)
-- one level up, with one deliberate difference: the requester does NOT
-- choose their own password. A player registering is vouched for by a join
-- code issued by their own guild leader; a guild-creation requester is a
-- total stranger asking for guild_admin (higher privilege, zero vouching),
-- so the login password is generated server-side only at approval time
-- (see admin-accounts "approve-guild-request"), never stored here.

CREATE TABLE IF NOT EXISTS public.guild_creation_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_tag TEXT NOT NULL,
    server_number TEXT NOT NULL,
    admin_id TEXT NOT NULL,
    discord_handle TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    reject_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Close the TOCTOU gap between two concurrent submissions for the same tag
-- or admin_id: only one 'pending' row per (case-insensitive) value can exist
-- at a time, same reasoning as idx_accounts_lower_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gcr_pending_tag
    ON public.guild_creation_requests (upper(guild_tag)) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_gcr_pending_admin_id
    ON public.guild_creation_requests (lower(admin_id)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_gcr_status_created ON public.guild_creation_requests (status, created_at);

ALTER TABLE public.guild_creation_requests ENABLE ROW LEVEL SECURITY;
-- No policies: access exclusively via service_role, through the
-- guild-request / admin-accounts Edge Functions. Same pattern as
-- login_throttle and the webauthn_challenges/account_passkeys tables.

-- ============================================================================
-- 1. Submission RPC — called only from the new guild-request Edge Function.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_submit_guild_request(
    p_guild_tag text,
    p_server_number text,
    p_admin_id text,
    p_discord_handle text,
    p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_tag text := upper(trim(p_guild_tag));
    v_admin_id text := trim(p_admin_id);
    v_discord text := trim(p_discord_handle);
    v_note text := NULLIF(trim(coalesce(p_note, '')), '');
    v_server text := trim(p_server_number);
    v_pending_count integer;
BEGIN
    IF v_tag IS NULL OR v_tag !~ '^[A-Z0-9_]{2,12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_guild_tag');
    END IF;
    IF v_server IS NULL OR v_server !~ '^[0-9]{4}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_server_number');
    END IF;
    IF v_admin_id IS NULL OR length(v_admin_id) < 3 OR length(v_admin_id) > 32 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_admin_id');
    END IF;
    IF v_discord IS NULL OR length(v_discord) < 2 OR length(v_discord) > 40 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_discord_handle');
    END IF;
    IF v_note IS NOT NULL AND length(v_note) > 500 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'note_too_long');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guilds g WHERE upper(g.id) = v_tag) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tag_taken');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.guild_creation_requests r
        WHERE upper(r.guild_tag) = v_tag AND r.status = 'pending'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tag_taken');
    END IF;

    IF EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(v_admin_id)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'admin_id_taken');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.guild_creation_requests r
        WHERE lower(r.admin_id) = lower(v_admin_id) AND r.status = 'pending'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'admin_id_taken');
    END IF;

    -- Volume guard: bound unbounded growth from a slow-drip spam script that
    -- rotates IPs and stays under the per-IP rate limit.
    SELECT count(*) INTO v_pending_count FROM public.guild_creation_requests WHERE status = 'pending';
    IF v_pending_count >= 200 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'too_many_pending_requests');
    END IF;

    INSERT INTO public.guild_creation_requests (guild_tag, server_number, admin_id, discord_handle, note)
    VALUES (v_tag, v_server, v_admin_id, v_discord, v_note);

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 2. Approval RPC — re-validates uniqueness atomically, creates the guild
--    row, marks the request approved. The Edge Function still does the
--    GoTrue shadow-user + gm_admin_upsert + gm_attach_shadow sequence itself
--    (reusing that existing code from action "create"), since that part
--    doesn't touch this table.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_approve_guild_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_req record;
BEGIN
    SELECT * INTO v_req
    FROM public.guild_creation_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guilds g WHERE upper(g.id) = upper(v_req.guild_tag)) THEN
        UPDATE public.guild_creation_requests SET status = 'rejected', reject_reason = 'tag_taken_at_approval', reviewed_at = now()
        WHERE id = p_request_id;
        RETURN jsonb_build_object('ok', false, 'error', 'tag_taken');
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounts a WHERE lower(a.id) = lower(v_req.admin_id)) THEN
        UPDATE public.guild_creation_requests SET status = 'rejected', reject_reason = 'admin_id_taken_at_approval', reviewed_at = now()
        WHERE id = p_request_id;
        RETURN jsonb_build_object('ok', false, 'error', 'admin_id_taken');
    END IF;

    INSERT INTO public.guilds (id, server_number) VALUES (v_req.guild_tag, v_req.server_number);

    UPDATE public.guild_creation_requests SET status = 'approved', reviewed_at = now() WHERE id = p_request_id;

    RETURN jsonb_build_object('ok', true, 'guild_tag', v_req.guild_tag, 'admin_id', v_req.admin_id, 'server_number', v_req.server_number);
END;
$$;

-- ============================================================================
-- 3. Rejection RPC.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_reject_guild_request(p_request_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM public.guild_creation_requests WHERE id = p_request_id FOR UPDATE;

    IF v_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
    IF v_status <> 'pending' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_pending');
    END IF;

    UPDATE public.guild_creation_requests
    SET status = 'rejected', reject_reason = NULLIF(trim(coalesce(p_reason, '')), ''), reviewed_at = now()
    WHERE id = p_request_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_submit_guild_request(text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_submit_guild_request(text, text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_approve_guild_request(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_approve_guild_request(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.gm_reject_guild_request(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_reject_guild_request(uuid, text) TO service_role;

-- ============================================================================
-- 4. Daily expiration: a pending request nobody reviews within 14 days frees
--    up its tag/admin_id for a future attempt. Pure SQL, no Edge Function
--    call needed (unlike event-reminders-tick).
-- ============================================================================
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron already enabled or managed by Supabase.';
END;
$$;

DO $$
BEGIN
    PERFORM cron.unschedule('guild-requests-expire')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'guild-requests-expire');

    PERFORM cron.schedule(
        'guild-requests-expire',
        '0 3 * * *',
        $job$
            UPDATE public.guild_creation_requests
            SET status = 'expired'
            WHERE status = 'pending' AND created_at < now() - interval '14 days';
        $job$
    );
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available in this environment; skipping schedule.';
END;
$$;

NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
SELECT cron.unschedule('guild-requests-expire') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'guild-requests-expire');
DROP FUNCTION IF EXISTS public.gm_reject_guild_request(uuid, text);
DROP FUNCTION IF EXISTS public.gm_approve_guild_request(uuid);
DROP FUNCTION IF EXISTS public.gm_submit_guild_request(text, text, text, text, text);
DROP TABLE IF EXISTS public.guild_creation_requests;
*/
