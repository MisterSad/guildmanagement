-- ============================================================================
-- 20260914110000_fix_event_reminders_trigger_and_tz.sql
--
-- P1 audit RC4 — scheduled reminders that never fire:
--   * The guarded cron wrapper gm_invoke_event_reminders() evaluated its
--     weekly slot table with extract(dow/hour/minute FROM now()), which follows
--     the PostgreSQL SESSION timezone. On a DB whose timezone GUC is not UTC,
--     every schedule-driven send (GvG daily/Saturday, SvS, Calamity) drifted by
--     whole days and silently never fired. All slot extraction is now pinned to
--     UTC via extract(... FROM timezone('utc', now())).
--   * The active-event due-window stays a pure TIMESTAMPTZ comparison
--     (start_at BETWEEN now() - '5 min' AND now() + '35 min') — timestamptz
--     arithmetic is timezone-agnostic by construction.
--   * The Vault guard on event_reminders_cron_secret is preserved; a missing
--     secret now emits an explicit, searchable WARNING before the wrapper
--     returns (observability instead of a silent no-op).
--
-- The slot list MUST stay in sync with
-- supabase/functions/event-reminders/index.ts (GVG_SCHEDULE, SVS_SCHEDULE,
-- CALAMITY_SCHEDULE and the GvG daily 00:01 window).
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
    --
    -- TZ invariant (RC4): every extract() below is evaluated against
    -- timezone('utc', now()) — a naive timestamp at UTC — so the weekly slot
    -- table can never be skewed by the database session timezone GUC. The
    -- event due-window compares start_at (TIMESTAMPTZ) with now()
    -- (TIMESTAMPTZ): pure timestamptz arithmetic, independent of the session
    -- timezone by definition.
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
        WHERE (((extract(dow FROM timezone('utc', now()))::int - s.dow + 7) % 7) * 1440
               + extract(hour FROM timezone('utc', now()))::int * 60
               + extract(minute FROM timezone('utc', now()))::int
               - (s.hh * 60 + s.mm)) BETWEEN 0 AND s.win
    ) THEN
        RETURN;
    END IF;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'event_reminders_cron_secret';

    IF v_secret IS NULL THEN
        RAISE WARNING 'gm_invoke_event_reminders: event_reminders_cron_secret not found in vault.decrypted_secrets — no reminders will be emitted until the secret is rotated in';
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

NOTIFY pgrst, 'reload schema';
