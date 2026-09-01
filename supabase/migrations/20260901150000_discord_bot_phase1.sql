-- 20260901150000_discord_bot_phase1.sql
--
-- Discord bot integration, Phase 1: account linking + foundations.
-- The bot is slash-commands-only (no Gateway connection) and reuses
-- member-portal's existing business logic rather than duplicating it --
-- see ARCHITECTURE notes in supabase/functions/discord-bot-interactions
-- and supabase/functions/_shared/discord.ts.
--
-- Account linking never trusts a self-typed value: /link (Discord) only
-- generates a short-lived code shown to that Discord user; confirming it
-- from the already-authenticated web Portal is what proves ownership.
-- discord_link_codes holds the not-yet-confirmed code; discord_account_links
-- holds the final 1:1 mapping once confirmed (member-portal's new
-- confirm-discord-link action).

CREATE TABLE IF NOT EXISTS public.discord_link_codes (
    code TEXT PRIMARY KEY,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_user ON public.discord_link_codes(discord_user_id);

CREATE TABLE IF NOT EXISTS public.discord_account_links (
    discord_user_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_account_links_account ON public.discord_account_links(account_id);

ALTER TABLE public.discord_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_account_links ENABLE ROW LEVEL SECURITY;
-- No policies: access exclusively via service_role, through
-- discord-bot-interactions (writes link codes) and member-portal (confirms
-- + reads the final link). Same pattern as login_throttle/webauthn_challenges.

NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
DROP TABLE IF EXISTS public.discord_account_links;
DROP TABLE IF EXISTS public.discord_link_codes;
*/
