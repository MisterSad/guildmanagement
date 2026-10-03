-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 — finding M4: RLS enabled, zero policies, nothing saying so
--
-- 13 tables (the audit counted 11; phase 1 removed `gm_payments` and
-- `push_subscriptions`, phases D2-D6 added four) have ROW LEVEL SECURITY
-- enabled and NO policy at all. That is a deny-all: `anon` and `authenticated`
-- read exactly zero rows, and `service_role` reaches them because it holds
-- `rolbypassrls`. So this is not a hole -- it is secure by construction.
--
-- The defect is that it is an IMPLICIT choice. A client read returns an empty
-- set, not an error, so the next person to query one of these tables from the
-- browser sees "no rows" and has no way to tell a deny-all posture from a
-- missing policy, a bad filter, or their own bug. This migration writes the
-- intent where that person will actually look.
--
-- ON `FORCE ROW LEVEL SECURITY`: five of the 13 had it, eight did not, and the
-- inconsistency looks like a security gap. Verified against this project's
-- roles, it is not one: `postgres` and `service_role` BOTH have
-- `rolbypassrls = true`, so FORCE changes nothing for either, and `anon` /
-- `authenticated` do not bypass, so zero policies already denies them with or
-- without it. FORCE is applied below purely so the posture is uniform and
-- survives a future where the owner no longer bypasses -- NOT because its
-- absence was exposing anything. Anyone tempted to treat the old inconsistency
-- as a finding should read this paragraph first.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Uniform posture (a no-op today; see the header) ───────────────────────
ALTER TABLE public.discord_account_links    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.discord_link_codes       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.guild_creation_requests  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.login_throttle           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tickets                  FORCE ROW LEVEL SECURITY;

-- ── State the intent, per table ───────────────────────────────────────────
-- The four tables created by phases D2-D5 already carry comments that say the
-- same thing; they are left alone rather than reworded.

COMMENT ON TABLE public.account_backup_codes IS
    'Hashed, single-use recovery codes. Restricted to super_admin by the auth-discord backup-login action: for any account that has an administrator above it, a backup code would be a second and weaker credential, so the higher admin''s unlink is the recovery path instead. Deny-all by design -- RLS enabled with NO policy, reachable only by service_role. A client read returns empty, which is the intent, not a missing policy. Survives the D7 passkey teardown.';

COMMENT ON TABLE public.account_passkeys IS
    'WebAuthn credentials (public key, counter, transports). Deny-all by design, service_role only -- auth-passkey mediates every read and write. Scheduled for removal in phase D7: a Discord claim destroys an account''s passkeys in the same transaction that creates the link, so this table drains as the migration proceeds.';

COMMENT ON TABLE public.discord_account_links IS
    'The account <-> Discord identity bijection, and after phase D7 the only credential that exists. UNIQUE on both sides, so one Discord user cannot hold two accounts and one account cannot be claimed twice. Deny-all by design, service_role only: a client that could read this could enumerate which accounts are claimable. Unlinking always issues a relink code in the same transaction (see account_link_codes).';

COMMENT ON TABLE public.discord_link_codes IS
    'Legacy verification codes for the Render-hosted Discord Gateway worker, predating the OAuth flow of phase D2. Deny-all by design, service_role only. Had no expiry sweep at all until the hourly gm_purge_discord_ephemera cron was added in 20260926190000.';

COMMENT ON TABLE public.discord_verification_throttle IS
    'Per-identity attempt budget for screenshot-based Discord verification in the Gateway worker. Deliberately NOT shared with discord_auth_throttle, which budgets sign-in: one table for both would let OCR scans throttle logins. Deny-all by design, service_role only.';

COMMENT ON TABLE public.guild_creation_requests IS
    'Tenant requests awaiting super_admin review, from the pre-Discord self-registration path. Largely superseded by phase D4, where a Discord account creates its own guild under SQL-enforced guardrails (account age recomputed from the snowflake, one guild per Discord identity, daily cap). Deny-all by design, service_role only. Slated for removal in D7.';

COMMENT ON TABLE public.login_throttle IS
    'Per-IP attempt buckets backing every rate limit in the system (auth-login, member-portal, admin-accounts, auth-passkey, auth-discord, player-register, guild-request). NOT removable with the password login it was built for. Deny-all by design, service_role only -- and necessarily so: it stores IP ADDRESSES, which makes it personal data and gives it a retention obligation (see the GDPR work in phase 8). As of phase 4 it fails CLOSED on a database error; it used to fail open, which silently disabled throttling under exactly the load an attacker would create.';

COMMENT ON TABLE public.tickets IS
    'Support tickets. Deny-all by design, service_role only: every read and write goes through the tickets Edge Function, which resolves the reporter from the JWT and refuses any caller whose role is not an admin one. Do NOT add a client policy to "fix" an empty result here -- the guild on a ticket is derived server-side from the caller, and a client-readable table would let a guild_admin enumerate other tenants'' reports.';

COMMENT ON TABLE public.webauthn_challenges IS
    'Single-use WebAuthn challenges, consumed BEFORE verification and looked up by the challenge value itself rather than by the account the client claims -- which is what stops a caller from redeeming another account''s challenge. Deny-all by design, service_role only. Removed in phase D7 along with account_passkeys.';

-- ── Assertion: the invariant, not just today's list ───────────────────────
DO $verify$
DECLARE
    v_undocumented text;
    v_unforced     text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_undocumented
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
      AND obj_description(c.oid, 'pg_class') IS NULL;

    IF v_undocumented IS NOT NULL THEN
        RAISE EXCEPTION 'policy-less RLS tables with no COMMENT explaining the deny-all: %', v_undocumented;
    END IF;

    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_unforced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
      AND NOT c.relforcerowsecurity;

    IF v_unforced IS NOT NULL THEN
        RAISE EXCEPTION 'deny-all tables still missing FORCE: %', v_unforced;
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
