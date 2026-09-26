-- ═══════════════════════════════════════════════════════════════════════════
-- Phase D2 — ephemeral state for the Discord OAuth sign-in flow
--
-- Two short-lived tables and their single-use consumption RPCs, plus the
-- hourly purge that `discord_link_codes` has never had since it was created.
--
-- WHY THIS IS NOT THE NATIVE SUPABASE DISCORD PROVIDER
-- `app_metadata` (`app_role`, `account_id`, `session_version`) is this app's
-- ONLY authorization channel: the client signs the user out when `app_role` is
-- absent, and `gm_session_is_valid()` compares `session_version`. GoTrue sets
-- none of the three on an OAuth login, so enabling `[auth.external.discord]`
-- would deadlock every session. `auth-discord` instead ends at
-- `establishShadowSession()`, the convergence point every existing identity
-- check already funnels through — no change to RLS, roles or claims.
--
-- THE TICKET CARRIES NO SESSION
-- `discord_auth_tickets` holds no GoTrue token. A ticket attests one thing:
-- that this browser completed a Discord authorization for that Discord user.
-- The session is minted only when the SPA redeems it, server-side. A leaked
-- ticket is therefore worth a single redemption inside a two-minute window,
-- not a bearer token.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. OAuth state (one row per sign-in attempt, consumed by the callback) ──
CREATE TABLE IF NOT EXISTS public.discord_oauth_states (
    state          text PRIMARY KEY,
    -- RFC 7636 verifier. Never leaves the database: the authorize URL carries
    -- only its S256 challenge, so an intercepted `code` cannot be redeemed.
    code_verifier  text        NOT NULL,
    -- The origin the sign-in started from, already validated by
    -- isAllowedOrigin() at /start. The callback trusts THIS, never a value
    -- coming back from Discord, which is what keeps it from being an open
    -- redirect.
    origin         text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_oauth_states_expires
    ON public.discord_oauth_states (expires_at);

-- ── 2. Redemption ticket (issued by the callback, spent by the SPA) ────────
CREATE TABLE IF NOT EXISTS public.discord_auth_tickets (
    ticket           text PRIMARY KEY,
    discord_user_id  text        NOT NULL,
    discord_username text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_auth_tickets_expires
    ON public.discord_auth_tickets (expires_at);

-- ── 3. Deny-all by construction ───────────────────────────────────────────
-- RLS enabled with no policy and FORCE: unreachable by anon and authenticated,
-- readable and writable only by service_role (the Edge Function). Finding M4
-- flagged eleven pre-existing tables in this posture as an undocumented
-- implicit choice; here it is explicit and commented from the start.
ALTER TABLE public.discord_oauth_states  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_oauth_states  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.discord_auth_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_auth_tickets  FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_oauth_states FROM anon, authenticated;
REVOKE ALL ON public.discord_auth_tickets FROM anon, authenticated;

COMMENT ON TABLE public.discord_oauth_states IS
    'Ephemeral Discord OAuth state + PKCE verifier. Deny-all by design: RLS is enabled with NO policy and FORCE, so only service_role (the auth-discord Edge Function) can reach it. A client read returns empty, not an error — that is intentional, not a missing policy.';
COMMENT ON TABLE public.discord_auth_tickets IS
    'Single-use redemption tickets for Discord sign-in. Holds NO GoTrue token: a ticket only attests that a browser completed a Discord authorization. Deny-all by design, same posture as discord_oauth_states.';

-- ── 4. Single-use consumption, atomic by construction ─────────────────────
-- DELETE ... RETURNING makes consumption atomic in one statement: two
-- concurrent redemptions of the same ticket cannot both succeed, because only
-- one of them deletes the row. A read-then-delete pair would race.
CREATE OR REPLACE FUNCTION public.gm_consume_discord_oauth_state(p_state text)
RETURNS TABLE (code_verifier text, origin text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    DELETE FROM public.discord_oauth_states s
    WHERE s.state = p_state
      AND s.expires_at > now()
    RETURNING s.code_verifier, s.origin;
$$;

CREATE OR REPLACE FUNCTION public.gm_consume_discord_auth_ticket(p_ticket text)
RETURNS TABLE (discord_user_id text, discord_username text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    DELETE FROM public.discord_auth_tickets t
    WHERE t.ticket = p_ticket
      AND t.expires_at > now()
    RETURNING t.discord_user_id, t.discord_username;
$$;

-- ── 5. Hourly purge ───────────────────────────────────────────────────────
-- Also sweeps `discord_link_codes`, which has had no cleanup of any kind since
-- it was created and has been accumulating expired rows ever since.
CREATE OR REPLACE FUNCTION public.gm_purge_discord_ephemera()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_states  int;
    v_tickets int;
    v_codes   int;
BEGIN
    DELETE FROM public.discord_oauth_states WHERE expires_at <= now();
    GET DIAGNOSTICS v_states = ROW_COUNT;

    DELETE FROM public.discord_auth_tickets WHERE expires_at <= now();
    GET DIAGNOSTICS v_tickets = ROW_COUNT;

    DELETE FROM public.discord_link_codes WHERE expires_at <= now();
    GET DIAGNOSTICS v_codes = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'oauth_states_purged', v_states,
        'auth_tickets_purged', v_tickets,
        'link_codes_purged', v_codes
    );
END;
$$;

-- ── 6. service_role only ──────────────────────────────────────────────────
-- Finding M15: maintenance and state functions had been left executable by
-- anon or authenticated. Revoke from PUBLIC too — a bare GRANT to PUBLIC is
-- what made gm_cleanup_expired_ocr_cache callable by anyone on the internet.
REVOKE ALL ON FUNCTION public.gm_consume_discord_oauth_state(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_consume_discord_auth_ticket(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_purge_discord_ephemera()          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.gm_consume_discord_oauth_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_consume_discord_auth_ticket(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_purge_discord_ephemera()          TO service_role;

-- ── 7. Schedule the purge ─────────────────────────────────────────────────
-- pg_cron jobs run as `postgres`, not as authenticated/anon, so the revokes
-- above do not affect them (verified when M15 was fixed).
SELECT cron.unschedule('hourly-discord-ephemera-purge')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hourly-discord-ephemera-purge');

SELECT cron.schedule(
    'hourly-discord-ephemera-purge',
    '23 * * * *',
    $cron$ SELECT public.gm_purge_discord_ephemera(); $cron$
);

-- ── 8. Assertions ─────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n int;
BEGIN
    -- Deny-all must be real: RLS enabled AND forced, with zero policies.
    SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('discord_oauth_states', 'discord_auth_tickets')
      AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_n <> 2 THEN RAISE EXCEPTION 'expected both tables to have RLS enabled and forced, got %', v_n; END IF;

    SELECT count(*) INTO v_n FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('discord_oauth_states', 'discord_auth_tickets');
    IF v_n <> 0 THEN RAISE EXCEPTION 'deny-all tables must carry no policy, found %', v_n; END IF;

    -- No unprivileged role may execute the three new functions.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_consume_discord_oauth_state', 'gm_consume_discord_auth_ticket', 'gm_purge_discord_ephemera')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_n <> 0 THEN RAISE EXCEPTION '% function(s) still executable by anon/authenticated', v_n; END IF;

    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'hourly-discord-ephemera-purge';
    IF v_n <> 1 THEN RAISE EXCEPTION 'purge cron not scheduled'; END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
