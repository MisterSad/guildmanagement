-- 20260902000000_discord_verification.sql
-- Discord bot: profile-screenshot verification (role assignment, nickname,
-- roster upsert). Per-Discord-user rate limiting for the OCR endpoint --
-- mirrors login_throttle's shape but keyed by discord_user_id instead of an
-- IP, since this endpoint is reachable by any Discord user in a monitored
-- channel and calls a metered AI vision API per attempt.

CREATE TABLE IF NOT EXISTS public.discord_verification_throttle (
    discord_user_id TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (discord_user_id, window_start)
);

ALTER TABLE public.discord_verification_throttle ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only (same posture as discord_link_codes /
-- discord_account_links from the Phase 1 migration).

REVOKE ALL ON TABLE public.discord_verification_throttle FROM public, anon, authenticated;
GRANT ALL ON TABLE public.discord_verification_throttle TO service_role;

NOTIFY pgrst, 'reload schema';
