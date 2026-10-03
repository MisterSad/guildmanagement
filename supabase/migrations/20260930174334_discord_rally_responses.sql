-- /call-to-arms forgot every answer whenever the Discord worker restarted.
--
-- The tally lived in a `Map` in the worker's memory. After a restart (every
-- deploy, every Render recycle) the next button press found no session and
-- rebuilt an EMPTY one, so the rally post was overwritten with only the latest
-- click: a leader counting on "18 present, 2.4B power" saw it drop to 1. The
-- embed cannot be the backup either: it lists at most 15 present and 10
-- late/absent names, by design.
--
-- The answers now live here, one row per (rally message, Discord user). The
-- worker upserts the clicker's row and rebuilds the embed from ALL rows of that
-- message, so the post is always complete and a restart loses nothing.
--
-- Personal data: a Discord user identifier and an in-game pseudonym, kept
-- 7 days (a rally is about a battle hours away), purged daily below and
-- disclosed in privacy.html §4. Only the service role reads or writes it:
-- RLS is enabled and forced with no policy at all, and the API roles hold no
-- grant.

CREATE TABLE IF NOT EXISTS public.discord_rally_responses (
    message_id      text        NOT NULL,
    discord_user_id text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('present', 'late', 'absent')),
    pseudo          text        NOT NULL,
    power           bigint      NOT NULL DEFAULT 0,
    fleet           bigint      NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS discord_rally_responses_updated_at_idx
    ON public.discord_rally_responses (updated_at);

ALTER TABLE public.discord_rally_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_rally_responses FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_rally_responses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.discord_rally_responses TO service_role;

-- Retention: 7 days, daily at 04:40 (after `daily-data-retention` at 04:30).
SELECT cron.schedule('purge-rally-responses', '40 4 * * *',
    $cron$ DELETE FROM public.discord_rally_responses WHERE updated_at < now() - interval '7 days'; $cron$);

NOTIFY pgrst, 'reload schema';
