-- ═══════════════════════════════════════════════════════════════════════════
-- Phase D3 — claim: attach Discord by proving you own the password
--
-- THIS IS IRREVERSIBLE PER ACCOUNT. A successful claim destroys the password
-- and every passkey, in the same transaction that creates the link. That is
-- the owner's decision (one sign-in method at any instant, never two), and it
-- is why D6 had to ship first: `gm_discord_unlink` is the only way back, and
-- it already exists.
--
-- 165 accounts are unlinked today: 102 members, 61 guild_admins, 1
-- server_admin, 1 super_admin.
--
-- ORDER THAT MUST NOT BE INVERTED
-- `session_version` is incremented INSIDE this function, and
-- `establishShadowSession` is called by the Edge Function AFTERWARDS. The
-- helper re-reads `session_version` fresh from `accounts`, so the token it
-- mints carries the new epoch and every older token dies. Doing it the other
-- way round would sign the person out at the exact moment of their claim.
--
-- SAFE BY CONSTRUCTION
-- `establishShadowSession` reads only `session_version` and
-- `gotrue_secret_enc` — never the password columns. An account with no
-- password left mints sessions exactly as before.
--
-- THIS IS A PASSWORD-GUESSING ORACLE
-- It verifies a password on an endpoint reachable without a session. The
-- per-IP budget is handled in the Edge Function; `discord_auth_throttle`
-- below adds a second budget keyed by Discord account, so rotating IPs does
-- not buy unlimited attempts. It is deliberately NOT
-- `discord_verification_throttle`: that is the screenshot-recognition budget,
-- and sharing it would let OCR scans throttle sign-ins, or vice versa.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Per-Discord-account attempt budget ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discord_auth_throttle (
    discord_user_id text        NOT NULL,
    window_start    timestamptz NOT NULL,
    attempts        integer     NOT NULL DEFAULT 0,
    PRIMARY KEY (discord_user_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_discord_auth_throttle_window
    ON public.discord_auth_throttle (window_start);

ALTER TABLE public.discord_auth_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_auth_throttle FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON public.discord_auth_throttle FROM anon, authenticated;

COMMENT ON TABLE public.discord_auth_throttle IS
    'Per-Discord-account attempt budget for the claim flow. Deliberately separate from discord_verification_throttle, which budgets screenshot recognition: sharing one table would let OCR scans throttle sign-ins. Deny-all by design, service_role only.';

-- Mirrors gm_check_ip_throttle exactly, keyed by Discord account instead of IP.
CREATE OR REPLACE FUNCTION public.gm_check_discord_throttle(
    p_discord_user_id text,
    p_limit           integer,
    p_window_ms       bigint,
    p_bucket          timestamptz
)
RETURNS TABLE (allowed boolean, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_total integer;
BEGIN
    SELECT COALESCE(SUM(t.attempts), 0) INTO v_total
    FROM public.discord_auth_throttle t
    WHERE t.discord_user_id = p_discord_user_id
      AND t.window_start >= p_bucket - make_interval(secs => (p_window_ms / 1000.0)::double precision);

    IF v_total >= p_limit THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    INSERT INTO public.discord_auth_throttle (discord_user_id, window_start, attempts)
    VALUES (p_discord_user_id, p_bucket, 1)
    ON CONFLICT (discord_user_id, window_start) DO UPDATE
        SET attempts = public.discord_auth_throttle.attempts + 1;

    RETURN QUERY SELECT true, GREATEST(0, p_limit - (v_total + 1));
END;
$$;

-- ── The claim itself ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_claim_account_with_discord(
    p_id              text,
    p_password        text,
    p_discord_user_id text
)
RETURNS TABLE (ok boolean, account_id text, role text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_check    record;
    v_acc      record;
    v_existing text;
BEGIN
    -- The SAME password check the login path uses. D1 extracted it from
    -- gm_check_login precisely so the transition could not develop a second,
    -- divergent credential check.
    SELECT * INTO v_check
    FROM public.gm_verify_password(p_id, p_password);

    IF v_check.is_locked OR v_check.error IS NOT DISTINCT FROM 'account_locked' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_locked'::text;
        RETURN;
    END IF;
    IF v_check.canonical_id IS NULL OR v_check.role IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'invalid_credentials'::text;
        RETURN;
    END IF;
    IF v_check.status IS DISTINCT FROM 'active' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'pending_approval'::text;
        RETURN;
    END IF;

    SELECT a.id, a.role INTO v_acc
    FROM public.accounts a
    WHERE a.id = v_check.canonical_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'invalid_credentials'::text;
        RETURN;
    END IF;

    -- Already claimed. Not an error the caller can fix by retrying, and
    -- saying so plainly beats a constraint violation.
    IF EXISTS (SELECT 1 FROM public.discord_account_links l WHERE l.account_id = v_acc.id) THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'already_linked'::text;
        RETURN;
    END IF;

    -- discord_account_links is a bijection; this Discord identity may already
    -- belong to someone else.
    SELECT l.account_id INTO v_existing
    FROM public.discord_account_links l
    WHERE l.discord_user_id = p_discord_user_id;
    IF v_existing IS NOT NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'discord_already_linked'::text;
        RETURN;
    END IF;

    INSERT INTO public.discord_account_links (discord_user_id, account_id)
    VALUES (p_discord_user_id, v_acc.id);

    -- ── The irreversible part ────────────────────────────────────────────
    -- One sign-in method at any instant, never two. The password goes, and
    -- with it the reversible `password_enc` copy that finding C0 was about --
    -- a claim therefore also retires that account's plaintext-recoverable
    -- password for good.
    UPDATE public.accounts
    SET password_hash   = NULL,
        password_enc    = NULL,
        session_version = COALESCE(session_version, 0) + 1
    WHERE id = v_acc.id;

    -- Passkeys and their in-flight ceremonies go too. Backup codes are dropped
    -- here as well; the Edge Function issues a FRESH set immediately for a
    -- super_admin, who has no administrator above them to unlink and reissue.
    DELETE FROM public.account_passkeys     p WHERE p.account_id = v_acc.id;
    DELETE FROM public.webauthn_challenges  w WHERE w.account_id = v_acc.id;
    DELETE FROM public.account_backup_codes b WHERE b.account_id = v_acc.id;

    RETURN QUERY SELECT true, v_acc.id, v_acc.role, NULL::text;
END;
$$;

-- ── service_role only ─────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.gm_check_discord_throttle(text, integer, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_claim_account_with_discord(text, text, text)                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_discord_throttle(text, integer, bigint, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_claim_account_with_discord(text, text, text)                TO service_role;

-- ── Retention: the throttle table is evidence for minutes, not months ─────
SELECT cron.unschedule('discord-auth-throttle-retention')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-auth-throttle-retention');

SELECT cron.schedule(
    'discord-auth-throttle-retention',
    '41 * * * *',
    $cron$ DELETE FROM public.discord_auth_throttle WHERE window_start < now() - interval '24 hours'; $cron$
);

-- ── Progress view for the transition window ───────────────────────────────
-- The cutover date must not be fixed until this approaches zero for admins.
-- A view rather than a saved query, so the number has one definition.
-- security_invoker so the view never runs with the owner's rights: it is
-- revoked from anon and authenticated anyway, but a view that silently
-- elevates is exactly what the `security_definer_view` advisor flags.
CREATE OR REPLACE VIEW public.gm_discord_claim_progress
WITH (security_invoker = true) AS
SELECT a.role,
       a.guild,
       count(*) FILTER (WHERE l.account_id IS NULL)     AS unlinked,
       count(*) FILTER (WHERE l.account_id IS NOT NULL) AS linked,
       count(*)                                         AS total
FROM public.accounts a
LEFT JOIN public.discord_account_links l ON l.account_id = a.id
GROUP BY a.role, a.guild;

REVOKE ALL ON public.gm_discord_claim_progress FROM anon, authenticated;

COMMENT ON VIEW public.gm_discord_claim_progress IS
    'Transition tracking for the Discord migration: unlinked vs linked accounts per role and guild. Do not fix a cutover date until `unlinked` is at or near zero for guild_admin, server_admin and super_admin.';

-- ── Assertions ────────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n int;
BEGIN
    SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'discord_auth_throttle'
      AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'discord_auth_throttle must have RLS enabled and forced'; END IF;

    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_claim_account_with_discord', 'gm_check_discord_throttle')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_n <> 0 THEN RAISE EXCEPTION '% claim function(s) still executable by anon/authenticated', v_n; END IF;

    -- The claim must reuse gm_verify_password, not re-implement a check.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_claim_account_with_discord'
      AND pg_get_functiondef(p.oid) ~ 'gm_verify_password';
    IF v_n <> 1 THEN RAISE EXCEPTION 'the claim must delegate to gm_verify_password'; END IF;

    -- And it must not reuse the screenshot-recognition budget.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_check_discord_throttle'
      AND pg_get_functiondef(p.oid) ~ 'discord_verification_throttle';
    IF v_n <> 0 THEN RAISE EXCEPTION 'the claim budget must not share discord_verification_throttle'; END IF;

    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'discord-auth-throttle-retention';
    IF v_n <> 1 THEN RAISE EXCEPTION 'throttle retention job not scheduled'; END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
