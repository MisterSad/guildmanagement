-- A Discord channel can run the screenshot reader in a narrower mode than
-- verification (owner request, 2026-11-07).
--
-- `rename_only`: a profile screenshot posted in the channel renames its author
-- after what the screenshot shows, and does nothing else. No role is given or
-- removed, nothing is written to the roster, no account is linked. It is for a
-- Discord server that belongs to no FGF guild, which is why it cannot live in
-- `guild_config` (every row there is keyed by a guild). It carries no guild
-- TAG, so ADR-022's rename cascade does not concern it.
--
-- Read by the Gateway worker (which channels to listen to) and by the
-- discord-profile-verification Edge Function, which resolves the mode itself
-- from the channel it is told about rather than trusting a mode in the request.
-- Rows are written by an operator in the SQL editor; no client and no Edge
-- Function writes here, so service_role is granted SELECT only.

CREATE TABLE public.discord_channel_modes (
    channel_id        text        PRIMARY KEY CHECK (channel_id ~ '^[0-9]{17,20}$'),
    discord_server_id text        NOT NULL    CHECK (discord_server_id ~ '^[0-9]{17,20}$'),
    mode              text        NOT NULL    CHECK (mode IN ('rename_only')),
    created_at        timestamptz NOT NULL    DEFAULT now()
);

ALTER TABLE public.discord_channel_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_channel_modes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_channel_modes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.discord_channel_modes TO service_role;

COMMENT ON TABLE public.discord_channel_modes IS
    'Per-channel mode for the Discord screenshot reader, for servers that belong to no FGF guild. rename_only: the author is renamed after the screenshot, nothing else happens. Deny-all by design: the Gateway worker and discord-profile-verification read it with service_role (SELECT only); an operator writes it from the SQL editor.';

DO $check$
BEGIN
    IF has_table_privilege('anon', 'public.discord_channel_modes', 'SELECT')
       OR has_table_privilege('authenticated', 'public.discord_channel_modes', 'SELECT') THEN
        RAISE EXCEPTION 'discord_channel_modes must not be readable by a client role';
    END IF;
    IF has_table_privilege('service_role', 'public.discord_channel_modes', 'INSERT') THEN
        RAISE EXCEPTION 'service_role must only read discord_channel_modes';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
