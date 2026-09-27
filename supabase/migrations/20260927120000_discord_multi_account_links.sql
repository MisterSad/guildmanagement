-- One Discord identity may now sign in to SEVERAL accounts, and pick which at
-- sign-in time.
--
-- Reported by the owner: signing in with Discord as HawkEye landed on the Player
-- Portal. Nothing was broken. The Discord identity was linked to
-- `HawkEyePlayer` (role `member`), so the session was a member session and the
-- routing was correct. The gap is that one person who is both an administrator
-- and a player could only ever attach ONE of their accounts, because
-- `discord_account_links` had `discord_user_id` as its primary key.
--
-- WHAT THIS GIVES UP, STATED PLAINLY
--
-- The owner chose this over the narrower option, having been told the cost. The
-- Discord migration plan leaned on that primary key as an implicit guarantee of
-- "one guild per Discord account". Measured before changing it, the guarantee is
-- NOT actually load-bearing there: `gm_discord_create_guild`,
-- `gm_discord_join_guild`, `gm_claim_account_with_discord` and
-- `gm_redeem_admin_invite` each refuse when the Discord identity has ANY link at
-- all, which is an explicit check that survives this change untouched. Guild
-- creation therefore remains once per Discord identity, enforced by the
-- function rather than by the key.
--
-- The one place that genuinely breaks is `gm_redeem_relink_code`, rewritten
-- below: its `ON CONFLICT (discord_user_id)` stops being valid the moment that
-- column is no longer a unique constraint, so relinking would have started
-- failing at runtime. That is the whole reason this is one migration and not
-- just an ALTER.
--
-- WHAT STAYS TRUE
--
--   * An ACCOUNT still belongs to exactly one Discord identity (new UNIQUE).
--     Without it, two people could both sign in as the same administrator.
--   * A link still dies with its account (the existing ON DELETE CASCADE).
--   * Attaching a second account still requires an admin-issued relink code —
--     there is no self-service path to it, and that is deliberate.

-- ---------------------------------------------------------------------------
-- 1. The key
-- ---------------------------------------------------------------------------
ALTER TABLE public.discord_account_links
  DROP CONSTRAINT IF EXISTS discord_account_links_pkey;

ALTER TABLE public.discord_account_links
  ADD CONSTRAINT discord_account_links_pkey
  PRIMARY KEY (discord_user_id, account_id);

-- An account belongs to one Discord identity. This is the half of the old
-- bijection that must NOT be relaxed.
ALTER TABLE public.discord_account_links
  DROP CONSTRAINT IF EXISTS discord_account_links_account_id_key;

ALTER TABLE public.discord_account_links
  ADD CONSTRAINT discord_account_links_account_id_key UNIQUE (account_id);

-- The sign-in path now reads every account for one Discord id, on every single
-- Discord sign-in. Without this index that is a sequential scan.
CREATE INDEX IF NOT EXISTS idx_discord_account_links_discord_user_id
  ON public.discord_account_links (discord_user_id);

COMMENT ON TABLE public.discord_account_links IS
'Discord identity to account links. A Discord identity may hold SEVERAL accounts (an administrator who is also a player picks at sign-in); an account belongs to exactly one Discord identity. Service-role only: RLS is enabled with no policies.';

-- ---------------------------------------------------------------------------
-- 2. gm_redeem_relink_code — the one function the key change breaks
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gm_redeem_relink_code(p_code_hash text, p_discord_user_id text)
RETURNS TABLE(ok boolean, account_id text, role text, err text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_code record;
    v_acc  record;
BEGIN
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
      FROM public.accounts a WHERE a.id = v_code.account_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_not_found'::text;
        RETURN;
    END IF;
    IF v_acc.status <> 'active' THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_not_active'::text;
        RETURN;
    END IF;

    -- The previous version refused when this Discord identity already held a
    -- link to a DIFFERENT account. That refusal was the bijection, and it is
    -- exactly the case now being allowed: an administrator attaching their
    -- player account, or the reverse. The code is still issued by an admin for
    -- one specific account and spent together with a fresh Discord
    -- authorization, so possession of the code alone remains insufficient.

    -- Detach this ACCOUNT from whatever identity held it. Aliased because the
    -- OUT parameter `account_id` would otherwise shadow the column and
    -- PL/pgSQL rejects the reference as ambiguous.
    DELETE FROM public.discord_account_links l WHERE l.account_id = v_acc.id;

    -- No ON CONFLICT: the delete above has just guaranteed no row exists for
    -- this account, and (discord_user_id, account_id) is the key now. The old
    -- `ON CONFLICT (discord_user_id)` would raise, because that column alone is
    -- no longer a unique constraint.
    INSERT INTO public.discord_account_links (discord_user_id, account_id)
    VALUES (p_discord_user_id, v_acc.id);

    UPDATE public.account_link_codes
       SET used_at = now(), used_by_discord_user_id = p_discord_user_id
     WHERE id = v_code.id;

    -- Any session minted before the link changed must stop being honoured.
    UPDATE public.accounts
       SET session_version = COALESCE(session_version, 0) + 1
     WHERE id = v_acc.id;

    RETURN QUERY SELECT true, v_acc.id, v_acc.role, NULL::text;
END;
$$;

COMMENT ON FUNCTION public.gm_redeem_relink_code(text, text) IS
'Spends a single-use relink code, attaching one account to a Discord identity. Since 2026-09-27 a Discord identity may hold several accounts, so this no longer refuses when the identity is already linked elsewhere; the account is still detached from any previous identity first.';

-- ---------------------------------------------------------------------------
-- 3. Assertions
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
    v_pk text;
    v_uniq integer;
    v_multi integer;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_pk
      FROM pg_constraint
     WHERE conrelid = 'public.discord_account_links'::regclass AND contype = 'p';
    IF v_pk IS NULL OR v_pk !~ 'discord_user_id' OR v_pk !~ 'account_id' THEN
        RAISE EXCEPTION 'primary key is not (discord_user_id, account_id): %', v_pk;
    END IF;

    SELECT count(*) INTO v_uniq
      FROM pg_constraint
     WHERE conrelid = 'public.discord_account_links'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (account_id)';
    IF v_uniq <> 1 THEN
        RAISE EXCEPTION 'account_id is not unique: two people could share one account';
    END IF;

    -- The rewritten function must not carry the clause that would now raise.
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'gm_redeem_relink_code'
           AND pg_get_functiondef(p.oid) ~* 'ON CONFLICT \(discord_user_id\)'
    ) THEN
        RAISE EXCEPTION 'gm_redeem_relink_code still uses ON CONFLICT (discord_user_id), which now raises';
    END IF;

    -- And the onboarding guards must still be explicit, not inherited from the
    -- key that was just relaxed.
    SELECT count(*) INTO v_multi
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('gm_discord_create_guild', 'gm_discord_join_guild',
                         'gm_claim_account_with_discord', 'gm_redeem_admin_invite')
       AND pg_get_functiondef(p.oid) ~* 'discord_already_linked';
    IF v_multi <> 4 THEN
        RAISE EXCEPTION
          'only % of the 4 onboarding functions still refuse an already-linked identity; one guild per Discord account is no longer guaranteed', v_multi;
    END IF;
END;
$assert$;

NOTIFY pgrst, 'reload schema';
