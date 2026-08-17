-- ============================================================================
-- Migration: 20260817113000_schedule_event_reminders_cron.sql
-- Description: Schedule event reminders tick cron job to invoke edge function every minute.
-- ============================================================================

DO $$
BEGIN
    -- Ensure pg_cron and pg_net extensions are present
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Extensions pg_cron / pg_net already enabled or managed by Supabase.';
END;
$$;

-- Unschedule previous job if exists
SELECT cron.unschedule('event-reminders-tick')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'event-reminders-tick'
);

-- Schedule event reminders tick every minute
SELECT cron.schedule(
    'event-reminders-tick',
    '* * * * *',
    $job$
        SELECT net.http_post(
            url := 'https://vgweufzwmfwplusskmuf.supabase.co/functions/v1/event-reminders',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer fgf-cron-secret-2026-secure-reminders',
                'x-cron-secret', 'fgf-cron-secret-2026-secure-reminders'
            ),
            body := '{}'::jsonb
        );
    $job$
);
