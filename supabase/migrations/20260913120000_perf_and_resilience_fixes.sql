-- 20260913120000_perf_and_resilience_fixes.sql
-- Phase 1 audit remediation: database performance & resilience fixes.
--   * Adds the indexes the hot read paths were missing and drops the one that
--     was fully redundant with login_throttle's primary key.
--   * Replaces the racing SELECT/INSERT/UPDATE IP throttle with an atomic
--     gm_check_ip_throttle RPC (ON CONFLICT DO UPDATE, no PK violations).
--   * Harden gm_check_login with bounded lock/statement timeouts and an atomic
--     failure counter, and restrict execute to service_role.
--   * Guards the every-minute reminder cron wrapper so pg_net is only invoked
--     when work is actually due, with bounded timeouts.
--   * Moves login_throttle retention from a per-request opportunist purge to a
--     scheduled pg_cron job.
-- Indexes are created non-concurrently on small tables; apply during a
-- low-traffic window if the tables have grown.

-- ============================================================================
-- 1. INDEXES
-- ============================================================================

-- event-reminders scans event_status by is_active + start_at every tick.
CREATE INDEX IF NOT EXISTS idx_event_status_active_start
    ON public.event_status (start_at)
    WHERE is_active;

-- sendWebPush fans out per guild (SELECT * FROM push_subscriptions WHERE guild = ?).
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_guild
    ON public.push_subscriptions (guild);

-- Retention DELETE only filters window_start.
CREATE INDEX IF NOT EXISTS idx_login_throttle_window_start
    ON public.login_throttle (window_start);

-- gm_cleanup_stale_reminder_locks filters key LIKE 'sent_%' AND updated_at.
CREATE INDEX IF NOT EXISTS idx_guild_config_sent_updated
    ON public.guild_config (updated_at)
    WHERE key LIKE 'sent_%';

-- Lockout sweeps / observability on locked accounts.
CREATE INDEX IF NOT EXISTS idx_accounts_locked_until
    ON public.accounts (locked_until)
    WHERE locked_until IS NOT NULL;

-- Fully redundant with login_throttle_pkey (ip, window_start); only add write cost.
DROP INDEX IF EXISTS public.idx_login_throttle_ip_time;

-- ============================================================================
-- 2. ATOMIC IP THROTTLE RPC
-- ============================================================================
-- Single round-trip, race-free replacement for the client-side
-- SELECT-then-INSERT/UPDATE that produced login_throttle_pkey violations and
-- lost increments under concurrency.
CREATE OR REPLACE FUNCTION public.gm_check_ip_throttle(
    p_ip text,
    p_limit integer,
    p_window_ms bigint,
    p_bucket timestamptz
)
RETURNS TABLE(allowed boolean, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_total integer;
BEGIN
    SELECT COALESCE(SUM(lt.attempts), 0)
    INTO v_total
    FROM public.login_throttle lt
    WHERE lt.ip = p_ip
      AND lt.window_start >= p_bucket - make_interval(secs => (p_window_ms / 1000.0)::double precision);

    IF v_total >= p_limit THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    INSERT INTO public.login_throttle (ip, window_start, attempts)
    VALUES (p_ip, p_bucket, 1)
    ON CONFLICT (ip, window_start) DO UPDATE
        SET attempts = public.login_throttle.attempts + 1;

    RETURN QUERY SELECT true, GREATEST(0, p_limit - (v_total + 1));
END;
$$;

REVOKE ALL ON FUNCTION public.gm_check_ip_throttle(text, integer, bigint, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_ip_throttle(text, integer, bigint, timestamptz) TO service_role;

-- ============================================================================
-- 3. HARDENED gm_check_login (timeouts + atomic failure counter)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
RETURNS TABLE(canonical_id text, role text, status text, is_locked boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
SET lock_timeout = '2s'
SET statement_timeout = '5s'
AS $$
DECLARE
    v_acc record;
    v_is_match boolean := false;
    v_key text;
    v_now_locked boolean;
BEGIN
    SELECT a.id, a.role, a.status, a.password_enc, a.password_hash, a.failed_login_count, a.locked_until
    INTO v_acc
    FROM public.accounts a
    WHERE LOWER(a.id) = LOWER(TRIM(p_id))
    LIMIT 1;

    IF v_acc.id IS NULL THEN
        RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, false, 'invalid_credentials'::text;
        RETURN;
    END IF;

    -- Check if locked
    IF v_acc.locked_until IS NOT NULL AND v_acc.locked_until > now() THEN
        RETURN QUERY SELECT v_acc.id, v_acc.role, v_acc.status, true, 'account_locked'::text;
        RETURN;
    END IF;

    -- Step 1: Check password_hash (bcrypt) if set
    IF v_acc.password_hash IS NOT NULL AND v_acc.password_hash <> '' THEN
        v_is_match := (extensions.crypt(p_password, v_acc.password_hash) = v_acc.password_hash);
    END IF;

    -- Step 2: Fallback to password_enc (legacy dual-read) if not matched yet
    IF NOT v_is_match AND v_acc.password_enc IS NOT NULL THEN
        SELECT s.decrypted_secret INTO v_key
        FROM vault.decrypted_secrets s
        WHERE s.name = 'gm_accounts_key';

        IF v_key IS NOT NULL THEN
            BEGIN
                v_is_match := (extensions.pgp_sym_decrypt(v_acc.password_enc, v_key) = p_password);
            EXCEPTION WHEN OTHERS THEN
                v_is_match := false;
            END;
        END IF;

        -- Lazy migration: upgrade password_hash to bcrypt on successful decrypt match
        IF v_is_match THEN
            UPDATE public.accounts
            SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
            WHERE id = v_acc.id;
        END IF;
    END IF;

    -- Handle outcome
    IF v_is_match THEN
        UPDATE public.accounts
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now()
        WHERE id = v_acc.id;

        RETURN QUERY SELECT v_acc.id, COALESCE(v_acc.role, 'member'), COALESCE(v_acc.status, 'active'), false, NULL::text;
        RETURN;
    ELSE
        -- Atomic increment: never derived from the stale v_acc snapshot, so
        -- concurrent failures cannot lose a strike and evade the lockout.
        -- Exponential backoff (15/30/45/60 min) after 5 consecutive failures.
        UPDATE public.accounts
        SET failed_login_count = public.accounts.failed_login_count + 1,
            locked_until = CASE
                WHEN public.accounts.failed_login_count + 1 >= 5 THEN
                    now() + (interval '15 minutes' * LEAST(4, GREATEST(1, (public.accounts.failed_login_count + 1) / 5)))
                ELSE NULL
            END
        WHERE id = v_acc.id
        RETURNING COALESCE(locked_until > now(), false)
        INTO v_now_locked;

        RETURN QUERY SELECT v_acc.id, NULL::text, NULL::text, v_now_locked, 'invalid_credentials'::text;
        RETURN;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_check_login(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_login(text, text) TO service_role;

-- ============================================================================
-- 4. GUARDED REMINDER CRON WRAPPER
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_invoke_event_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
SET lock_timeout = '1s'
SET statement_timeout = '3s'
AS $$
DECLARE
    v_secret text;
BEGIN
    -- Cheap due-window guard: skip the HTTP fan-out unless an active event is
    -- within [now() - 5 min, now() + 35 min], or the current UTC minute lands
    -- in a weekly schedule slot handled directly by the Edge Function (GvG
    -- daily/Saturday, SvS, Calamity). Those schedule-driven sends have no
    -- event_status row, so omitting the second branch would silently drop
    -- every GvG/SvS/Calamity notification.
    -- The slot list MUST stay in sync with supabase/functions/event-reminders/index.ts.
    IF NOT EXISTS (
        SELECT 1
        FROM public.event_status
        WHERE is_active
          AND start_at BETWEEN now() - interval '5 minutes' AND now() + interval '35 minutes'
    ) AND NOT EXISTS (
        SELECT 1
        FROM (VALUES
            -- GvG daily tasks: Monday-Saturday 00:01 (window 5 min)
            (1, 0, 1, 5), (2, 0, 1, 5), (3, 0, 1, 5),
            (4, 0, 1, 5), (5, 0, 1, 5), (6, 0, 1, 5),
            -- GvG Saturday war slots "now" (window 10 min)
            (6, 0, 0, 10), (6, 1, 0, 10), (6, 10, 0, 10),
            (6, 13, 0, 10), (6, 14, 0, 10), (6, 22, 0, 10),
            -- GvG Saturday reminder slots (window 10 min)
            (5, 23, 55, 10), (6, 0, 55, 10), (6, 9, 55, 10),
            (6, 12, 55, 10), (6, 13, 55, 10), (6, 21, 55, 10),
            -- SvS slots (window 10 min)
            (5, 20, 0, 10), (5, 21, 0, 10), (5, 22, 0, 10),
            (5, 23, 55, 10), (6, 0, 0, 10), (6, 13, 30, 10),
            (6, 13, 55, 10), (6, 14, 0, 10),
            -- Calamity Befalls rounds (window 10 min)
            (1, 23, 50, 10),
            (2, 2, 50, 10), (2, 5, 50, 10), (2, 8, 50, 10),
            (2, 11, 50, 10), (2, 14, 50, 10), (2, 17, 50, 10),
            (2, 20, 50, 10), (2, 23, 50, 10),
            (3, 2, 50, 10), (3, 5, 50, 10), (3, 8, 50, 10),
            (3, 11, 50, 10), (3, 14, 50, 10), (3, 17, 50, 10),
            (3, 20, 50, 10)
        ) AS s(dow, hh, mm, win)
        WHERE (((extract(dow FROM now())::int - s.dow + 7) % 7) * 1440
               + extract(hour FROM now())::int * 60
               + extract(minute FROM now())::int
               - (s.hh * 60 + s.mm)) BETWEEN 0 AND s.win
    ) THEN
        RETURN;
    END IF;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'event_reminders_cron_secret';

    IF v_secret IS NULL THEN
        RAISE WARNING 'event_reminders_cron_secret not found in vault.decrypted_secrets';
        RETURN;
    END IF;

    PERFORM net.http_post(
        url := 'https://vgweufzwmfwplusskmuf.supabase.co/functions/v1/event-reminders',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_secret,
            'x-cron-secret', v_secret
        ),
        body := '{}'::jsonb
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_invoke_event_reminders() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_invoke_event_reminders() TO service_role;

-- ============================================================================
-- 5. login_throttle RETENTION CRON (replaces the per-request purge)
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('login-throttle-retention')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'login-throttle-retention');

        PERFORM cron.schedule(
            'login-throttle-retention',
            '17 * * * *',
            $job$DELETE FROM public.login_throttle WHERE window_start < now() - interval '24 hours';$job$
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available in this environment; skipping login_throttle retention schedule.';
END $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
DROP INDEX IF EXISTS public.idx_event_status_active_start;
DROP INDEX IF EXISTS public.idx_push_subscriptions_guild;
DROP INDEX IF EXISTS public.idx_login_throttle_window_start;
DROP INDEX IF EXISTS public.idx_guild_config_sent_updated;
DROP INDEX IF EXISTS public.idx_accounts_locked_until;
CREATE INDEX IF NOT EXISTS idx_login_throttle_ip_time ON public.login_throttle (ip, window_start DESC);
SELECT cron.unschedule('login-throttle-retention');
DROP FUNCTION IF EXISTS public.gm_check_ip_throttle(text, integer, bigint, timestamptz);
NOTIFY pgrst, 'reload schema';
*/
