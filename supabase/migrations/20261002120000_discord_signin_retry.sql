-- Discord sign-in: a mistake no longer costs a full Discord round trip.
--
-- Every post-callback action (claim, onboard, redeem-code) spends its ticket
-- before running, and until now no failure path issued a new one. A mistyped
-- join code, a UID not yet on the roster or a taken tag therefore ended the
-- attempt: the person corrected the field, pressed the button again, and got
-- `ticket_invalid`.
--
-- `auth-discord` now re-issues a continuation ticket on a RECOVERABLE error.
-- The chain is bounded here, in the table, not in the function: `attempts`
-- counts the re-issues, and the CHECK makes a sixth one unrepresentable. One
-- Discord authorization is therefore worth at most six attempts, whatever a
-- stale or buggy deploy believes.
--
-- `display_name` carries Discord's `global_name` for the ticket's lifetime
-- only (2 to 15 minutes, purged hourly), so the welcome screen can greet the
-- person by the name their friends see rather than their handle. Nothing about
-- it is stored on the account.

ALTER TABLE public.discord_auth_tickets
    ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE public.discord_auth_tickets
    DROP CONSTRAINT IF EXISTS discord_auth_tickets_attempts_range;
ALTER TABLE public.discord_auth_tickets
    ADD CONSTRAINT discord_auth_tickets_attempts_range CHECK (attempts BETWEEN 0 AND 5);

ALTER TABLE public.discord_auth_tickets
    DROP CONSTRAINT IF EXISTS discord_auth_tickets_display_name_len;
ALTER TABLE public.discord_auth_tickets
    ADD CONSTRAINT discord_auth_tickets_display_name_len CHECK (display_name IS NULL OR length(display_name) <= 64);

-- The return type changes, which CREATE OR REPLACE cannot do. The only caller
-- is the auth-discord Edge Function (no SQL function references it), and the
-- drop and create run in this migration's single transaction.
DROP FUNCTION IF EXISTS public.gm_consume_discord_auth_ticket(text);

CREATE FUNCTION public.gm_consume_discord_auth_ticket(p_ticket text)
RETURNS TABLE (discord_user_id text, discord_username text, display_name text, attempts smallint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    DELETE FROM public.discord_auth_tickets t
    WHERE t.ticket = p_ticket
      AND t.expires_at > now()
    RETURNING t.discord_user_id, t.discord_username, t.display_name, t.attempts;
$$;

REVOKE ALL ON FUNCTION public.gm_consume_discord_auth_ticket(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_consume_discord_auth_ticket(text) TO service_role;

NOTIFY pgrst, 'reload schema';
