-- ═══════════════════════════════════════════════════════════════════════════
-- Phase D6 — unlink and recovery
--
-- Must land BEFORE the D3 claim window opens. Once Discord is the only way in,
-- an account whose Discord link is lost or wrong has no route back unless one
-- is built first. That is the whole point of this phase.
--
-- THE CENTRAL RULE: AN UNLINK ALWAYS ISSUES A RELINK CODE.
-- Never expose a bare deletion. A "remove the link" button with no code to
-- follow is not a recovery mechanism, it is a way to strand a colleague — so
-- `gm_discord_unlink` does both in one transaction and cannot do only the
-- first. The error is made structurally impossible rather than documented.
--
-- ONE TABLE, TWO KINDS. `relink` is implemented here; `admin_invite` (D5)
-- shares the table because a single-use, hashed, expiring code is the same
-- object either way. The CHECK constraints below enforce the shape each kind
-- requires, so a malformed row cannot be written by either phase.
--
-- HASHED, NEVER PLAINTEXT. Deliberately the opposite of `join_code_plain`,
-- which is stored in the clear because it is a *shared* code an admin reads
-- out and reissues. These are single-recipient credentials: the plaintext is
-- returned exactly once, in the HTTP response, and never persisted.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.account_link_codes (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SHA-256 of the plaintext. UNIQUE so a collision fails loudly at insert
    -- rather than silently shadowing an existing code.
    code_hash               text        NOT NULL UNIQUE,
    kind                    text        NOT NULL,
    -- relink: the account to reattach. admin_invite: NULL until redeemed.
    account_id              text        REFERENCES public.accounts(id) ON DELETE CASCADE,
    -- admin_invite only: where the new admin lands.
    guild                   text,
    role                    text,
    issued_by               text        NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    expires_at              timestamptz NOT NULL,
    used_at                 timestamptz,
    used_by_discord_user_id text,

    CONSTRAINT account_link_codes_kind_check
        CHECK (kind IN ('relink', 'admin_invite')),
    -- A relink code without an account is meaningless; an invite without a
    -- destination is meaningless. Enforce both rather than trusting callers.
    CONSTRAINT account_link_codes_relink_shape
        CHECK (kind <> 'relink' OR account_id IS NOT NULL),
    CONSTRAINT account_link_codes_invite_shape
        CHECK (kind <> 'admin_invite' OR (guild IS NOT NULL AND role IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_account_link_codes_expires
    ON public.account_link_codes (expires_at);
-- Supports the "at most N outstanding codes" cap D5 will enforce per guild.
CREATE INDEX IF NOT EXISTS idx_account_link_codes_open
    ON public.account_link_codes (kind, guild)
    WHERE used_at IS NULL;

ALTER TABLE public.account_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_link_codes FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON public.account_link_codes FROM anon, authenticated;

COMMENT ON TABLE public.account_link_codes IS
    'Single-use, hashed, expiring codes for Discord account recovery (kind=relink) and additional-admin invitations (kind=admin_invite, phase D5). Deny-all by design: RLS enabled with NO policy and FORCE, reachable only by service_role. The plaintext code is returned once in an HTTP response and never stored.';

-- ── Unlink + issue, atomically ────────────────────────────────────────────
-- Returns the Discord id that was detached so the caller can name it in the
-- audit entry. Note this deliberately succeeds when the account has NO link:
-- issuing a relink code to an account that was never linked is exactly the
-- escape hatch the D3 transition needs for the 99 accounts that have never
-- logged in and will not remember a password they never used.
CREATE OR REPLACE FUNCTION public.gm_discord_unlink(
    p_account_id text,
    p_code_hash  text,
    p_expires_at timestamptz,
    p_actor      text
)
RETURNS TABLE (ok boolean, previous_discord_user_id text, guild text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_acc   record;
    v_prev  text;
BEGIN
    SELECT a.id, a.guild, a.role INTO v_acc
    FROM public.accounts a
    WHERE a.id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_not_found'::text;
        RETURN;
    END IF;

    DELETE FROM public.discord_account_links l
    WHERE l.account_id = v_acc.id
    RETURNING l.discord_user_id INTO v_prev;

    INSERT INTO public.account_link_codes (code_hash, kind, account_id, issued_by, expires_at)
    VALUES (p_code_hash, 'relink', v_acc.id, p_actor, p_expires_at);

    -- Any session minted before the unlink must stop working: whoever held the
    -- old Discord link may still hold a live token.
    UPDATE public.accounts
    SET session_version = COALESCE(session_version, 0) + 1
    WHERE id = v_acc.id;

    RETURN QUERY SELECT true, v_prev, v_acc.guild, NULL::text;
END;
$$;

-- ── Redeem a relink code ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_redeem_relink_code(
    p_code_hash        text,
    p_discord_user_id  text
)
RETURNS TABLE (ok boolean, account_id text, role text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_code record;
    v_acc  record;
    v_existing text;
BEGIN
    -- Lock the code first: two concurrent redemptions must not both pass.
    SELECT c.id, c.account_id INTO v_code
    FROM public.account_link_codes c
    WHERE c.code_hash = p_code_hash
      AND c.kind = 'relink'
      AND c.used_at IS NULL
      AND c.expires_at > now()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'code_invalid'::text;
        RETURN;
    END IF;

    SELECT a.id, a.role, a.status INTO v_acc
    FROM public.accounts a
    WHERE a.id = v_code.account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_not_found'::text;
        RETURN;
    END IF;
    IF v_acc.status <> 'active' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_not_active'::text;
        RETURN;
    END IF;

    -- discord_account_links is a bijection (PK on discord_user_id, UNIQUE on
    -- account_id). If this Discord identity is already attached elsewhere,
    -- say so instead of letting the insert fail on a constraint the caller
    -- cannot interpret.
    SELECT l.account_id INTO v_existing
    FROM public.discord_account_links l
    WHERE l.discord_user_id = p_discord_user_id;

    IF v_existing IS NOT NULL AND v_existing <> v_acc.id THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'discord_already_linked'::text;
        RETURN;
    END IF;

    -- Aliased: the OUT parameter `account_id` would otherwise shadow the
    -- column, and PL/pgSQL rejects the reference as ambiguous.
    DELETE FROM public.discord_account_links l WHERE l.account_id = v_acc.id;
    INSERT INTO public.discord_account_links (discord_user_id, account_id)
    VALUES (p_discord_user_id, v_acc.id)
    ON CONFLICT (discord_user_id) DO UPDATE SET account_id = EXCLUDED.account_id;

    UPDATE public.account_link_codes
    SET used_at = now(), used_by_discord_user_id = p_discord_user_id
    WHERE id = v_code.id;

    -- The link changed: retire anything minted under the previous one.
    UPDATE public.accounts
    SET session_version = COALESCE(session_version, 0) + 1
    WHERE id = v_acc.id;

    RETURN QUERY SELECT true, v_acc.id, v_acc.role, NULL::text;
END;
$$;

-- ── service_role only ─────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.gm_discord_unlink(text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_redeem_relink_code(text, text)                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_discord_unlink(text, text, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_redeem_relink_code(text, text)                TO service_role;

-- ── Fold the new table into the existing hourly purge ─────────────────────
-- Expired, unredeemed codes are dead weight and, worse, a lingering hash to
-- attack offline. Only expired-and-unused rows go: a redeemed code stays as
-- evidence of who used it and when.
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
    v_links   int;
BEGIN
    DELETE FROM public.discord_oauth_states WHERE expires_at <= now();
    GET DIAGNOSTICS v_states = ROW_COUNT;

    DELETE FROM public.discord_auth_tickets WHERE expires_at <= now();
    GET DIAGNOSTICS v_tickets = ROW_COUNT;

    DELETE FROM public.discord_link_codes WHERE expires_at <= now();
    GET DIAGNOSTICS v_codes = ROW_COUNT;

    DELETE FROM public.account_link_codes WHERE expires_at <= now() AND used_at IS NULL;
    GET DIAGNOSTICS v_links = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'oauth_states_purged', v_states,
        'auth_tickets_purged', v_tickets,
        'link_codes_purged', v_codes,
        'account_link_codes_purged', v_links
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_purge_discord_ephemera() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_purge_discord_ephemera() TO service_role;

-- ── Assertions ────────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n int;
BEGIN
    SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'account_link_codes'
      AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'account_link_codes must have RLS enabled and forced'; END IF;

    SELECT count(*) INTO v_n FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'account_link_codes';
    IF v_n <> 0 THEN RAISE EXCEPTION 'account_link_codes must carry no policy, found %', v_n; END IF;

    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_discord_unlink', 'gm_redeem_relink_code', 'gm_purge_discord_ephemera')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_n <> 0 THEN RAISE EXCEPTION '% function(s) still executable by anon/authenticated', v_n; END IF;

    -- The purge must still sweep every ephemeral table, including the one
    -- that had no cleanup before phase D2.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_purge_discord_ephemera'
      AND pg_get_functiondef(p.oid) ~ 'discord_link_codes'
      AND pg_get_functiondef(p.oid) ~ 'account_link_codes'
      AND pg_get_functiondef(p.oid) ~ 'discord_oauth_states'
      AND pg_get_functiondef(p.oid) ~ 'discord_auth_tickets';
    IF v_n <> 1 THEN RAISE EXCEPTION 'the purge no longer covers every ephemeral table'; END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
