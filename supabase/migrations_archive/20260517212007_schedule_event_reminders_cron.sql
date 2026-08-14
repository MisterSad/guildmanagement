select cron.schedule(
    'event-reminders-tick',
    '* * * * *',
    $job$
        select net.http_post(
            url := 'https://vgweufzwmfwplusskmuf.supabase.co/functions/v1/event-reminders',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret')
            ),
            body := '{}'::jsonb
        );
    $job$
);;
