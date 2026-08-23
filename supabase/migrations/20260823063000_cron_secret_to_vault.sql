-- 20260823063000_cron_secret_to_vault.sql
-- Workstream W4: Read pg_cron secret dynamically from Supabase Vault
--
-- Drops previous pg_cron job with hardcoded headers and creates a SECURITY DEFINER
-- wrapper function gm_invoke_event_reminders() that reads decrypted secret from vault.decrypted_secrets.

-- 1. Unschedule previous cron jobs if they exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('event-reminders-tick')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'event-reminders-tick');

        PERFORM cron.unschedule('fgf-event-reminders')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fgf-event-reminders');
    END IF;
END $$;

-- 2. Create the invocation wrapper retrieving secret from Vault
CREATE OR REPLACE FUNCTION public.gm_invoke_event_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_secret text;
BEGIN
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

-- 3. Grants hygiene: service_role only
REVOKE ALL ON FUNCTION public.gm_invoke_event_reminders() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_invoke_event_reminders() TO service_role;

-- 4. Schedule the pg_cron job to invoke wrapper every minute
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'fgf-event-reminders',
            '* * * * *',
            'SELECT public.gm_invoke_event_reminders();'
        );
    END IF;
END $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- Unschedule and drop function:
SELECT cron.unschedule('fgf-event-reminders');
DROP FUNCTION IF EXISTS public.gm_invoke_event_reminders();
*/
