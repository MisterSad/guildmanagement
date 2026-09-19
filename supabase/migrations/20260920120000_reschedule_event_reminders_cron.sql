-- 20260920120000_reschedule_event_reminders_cron.sql
-- TICKET-06 [PERF-01]: Reschedule pg_cron fgf-event-reminders from 1-min to 5-min
-- Reduces execution overhead by 80% (from 43,200 to 8,640 monthly runs).

-- 1. Unschedule old 1-minute job and reschedule at 5 minutes
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('fgf-event-reminders')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fgf-event-reminders');

        PERFORM cron.schedule(
            'fgf-event-reminders',
            '*/5 * * * *',
            'SELECT public.gm_invoke_event_reminders();'
        );
    END IF;
END $$;

-- 2. Update gm_invoke_event_reminders() with calibrated GvG daily task window (6 min)
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
    IF NOT EXISTS (
        SELECT 1
        FROM public.event_status
        WHERE is_active
          AND start_at BETWEEN now() - interval '5 minutes' AND now() + interval '35 minutes'
    ) AND NOT EXISTS (
        SELECT 1
        FROM (VALUES
            -- GvG daily tasks: Monday-Saturday 00:01 (widened to 6 min for 5-min cron resilience)
            (1, 0, 1, 6), (2, 0, 1, 6), (3, 0, 1, 6),
            (4, 0, 1, 6), (5, 0, 1, 6), (6, 0, 1, 6),
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

-- 3. Grants hygiene: service_role only
REVOKE ALL ON FUNCTION public.gm_invoke_event_reminders() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_invoke_event_reminders() TO service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
