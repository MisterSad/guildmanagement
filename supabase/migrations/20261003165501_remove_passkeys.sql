-- 20261003165501_remove_passkeys.sql
--
-- Passkeys are removed entirely (owner decision, restated 2026-10-03). Sign-in
-- is Discord, with ID + password kept during the transition.
--
-- The UI went on 2026-09-27, but auth-passkey stayed deployed. The 10 accounts
-- holding a passkey could still sign in with it by calling the API directly.
-- The function is now a 410 tombstone; this drops what it used.
--
-- Kept: account_backup_codes. The super_admin's recovery codes belong to the
-- Discord flow (auth-discord backup-login, admin-accounts backup-codes-*).
--
-- Order: apply AFTER the tombstone and the passkey-free auth-login are
-- deployed. The previous auth-login read account_passkeys on every password
-- sign-in.

-- ── 1. Dependents first (the schema-change checklist) ─────────────────────────
-- Found by scanning pg_get_functiondef for both table names: the Discord claim
-- and the hourly ephemera purge. No policy, view, trigger or cron job names
-- either table.

DO $claim$
DECLARE
  v_def text := pg_get_functiondef('public.gm_claim_account_with_discord(text,text,text)'::regprocedure);
  v_old text := E'    -- Passkeys, in-flight ceremonies and backup codes go too. The Edge\n'
             || E'    -- Function issues a FRESH set of backup codes immediately for a\n'
             || E'    -- super_admin, who has no administrator above them to unlink and reissue.\n'
             || E'    DELETE FROM public.account_passkeys     p WHERE p.account_id = v_acc.id;\n'
             || E'    DELETE FROM public.webauthn_challenges  w WHERE w.account_id = v_acc.id;\n'
             || E'    DELETE FROM public.account_backup_codes b WHERE b.account_id = v_acc.id;\n';
BEGIN
  IF v_def !~ '(account_passkeys|webauthn_challenges)' THEN
    RAISE NOTICE 'gm_claim_account_with_discord no longer names the passkey tables';
    RETURN;
  END IF;
  IF md5(v_def) <> 'bd8c0de38c06eeeaac0e76164f0f2621' OR position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'gm_claim_account_with_discord changed since this migration was written; re-read it first';
  END IF;
  v_def := replace(v_def, v_old,
       E'    -- Backup codes go too. The Edge Function issues a FRESH set immediately\n'
    || E'    -- for a super_admin, who has no administrator above them to unlink and\n'
    || E'    -- reissue. (Passkeys no longer exist: removed 2026-10-03.)\n'
    || E'    DELETE FROM public.account_backup_codes b WHERE b.account_id = v_acc.id;\n');
  EXECUTE v_def;
END
$claim$;

CREATE OR REPLACE FUNCTION public.gm_purge_discord_ephemera()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_states int; v_tickets int; v_codes int; v_links int; v_throttle int;
BEGIN
    DELETE FROM public.discord_oauth_states WHERE expires_at <= now();
    GET DIAGNOSTICS v_states = ROW_COUNT;
    DELETE FROM public.discord_auth_tickets WHERE expires_at <= now();
    GET DIAGNOSTICS v_tickets = ROW_COUNT;
    DELETE FROM public.discord_link_codes WHERE expires_at <= now();
    GET DIAGNOSTICS v_codes = ROW_COUNT;
    -- Only expired AND unused: a redeemed code stays as evidence of who used
    -- it and when.
    DELETE FROM public.account_link_codes WHERE expires_at <= now() AND used_at IS NULL;
    GET DIAGNOSTICS v_links = ROW_COUNT;
    DELETE FROM public.discord_verification_throttle WHERE window_start < now() - interval '24 hours';
    GET DIAGNOSTICS v_throttle = ROW_COUNT;
    RETURN jsonb_build_object(
        'ok', true,
        'oauth_states_purged', v_states,
        'auth_tickets_purged', v_tickets,
        'link_codes_purged', v_codes,
        'account_link_codes_purged', v_links,
        'verification_throttle_purged', v_throttle
    );
END;
$$;
REVOKE ALL ON FUNCTION public.gm_purge_discord_ephemera() FROM PUBLIC, anon, authenticated;

-- ── 2. The tables ─────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.webauthn_challenges;
DROP TABLE IF EXISTS public.account_passkeys;

-- ── 3. Assert the end state ───────────────────────────────────────────────────

DO $check$
BEGIN
  IF to_regclass('public.account_passkeys') IS NOT NULL OR to_regclass('public.webauthn_challenges') IS NOT NULL THEN
    RAISE EXCEPTION 'a passkey table still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind = 'f'
               AND pg_get_functiondef(p.oid) ~ '(account_passkeys|webauthn_challenges)') THEN
    RAISE EXCEPTION 'a function still names a dropped passkey table';
  END IF;
  IF to_regclass('public.account_backup_codes') IS NULL THEN
    RAISE EXCEPTION 'the super_admin recovery codes must survive';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
