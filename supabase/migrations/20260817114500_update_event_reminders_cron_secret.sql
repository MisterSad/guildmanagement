-- Update pg_cron job with the exact CRON_SECRET
SELECT cron.unschedule('event-reminders-tick')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'event-reminders-tick'
);

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
