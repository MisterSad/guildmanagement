-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 — finding C1: session revocation was documented but not implemented
--
-- `gm_session_is_valid()` has existed since 20260913130000, documented as
-- making pre-bump tokens fail "on any policy that invokes it". Queried live:
-- **ZERO policies invoked it.** Meanwhile admin-accounts calls
-- bumpSessionVersion() with the comment "pre-reset access/refresh tokens must
-- stop matching" -- and nothing made them stop.
--
-- Suspension and role changes DID take effect immediately, because every RLS
-- helper re-reads `accounts` live and requires status = 'active'. The one case
-- that was broken is the one the ADR advertised: revoking a STOLEN token after
-- a password reset.
--
-- WHY THIS IS ABSENT-TOLERANT, AND WHY THAT MATTERED
-- Only **49 of 171** GoTrue users carried `session_version` in their
-- app_metadata; 122 did not, because they have not signed in since the claim
-- was introduced. A strict check would have returned false for all 122 and
-- taken 71% of the user base offline the moment it shipped.
--
-- So: a token with NO claim is tolerated (legacy), a token whose claim is
-- STALE is refused. The backfill below gives every user the claim, so refreshed
-- tokens carry it within the hour, and tightening this to strict later becomes
-- a one-line change once `with_session_version` reaches 171.
--
-- Measured before applying: 150 of 171 accounts sit at epoch 0, so no stale
-- token can exist for them at all; 21 have a higher epoch, of which 15 held a
-- live session. Those 15 are exactly the accounts whose tokens were SUPPOSED to
-- have been revoked by a past password reset or role change, and because
-- app_metadata is in sync for all 171, their next token refresh mints a valid
-- token without anyone re-entering credentials.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Give every linked GoTrue user the claim ────────────────────────────
UPDATE auth.users u
SET raw_app_meta_data =
        COALESCE(u.raw_app_meta_data, '{}'::jsonb)
        || jsonb_build_object('session_version', COALESCE(a.session_version, 0))
FROM public.accounts a
WHERE a.auth_user_id = u.id
  AND NOT (COALESCE(u.raw_app_meta_data, '{}'::jsonb) ? 'session_version');

-- ── 2. The check itself ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_session_is_valid()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT COALESCE(
        (
            SELECT
                CASE
                    -- Legacy token, minted before the claim existed. Tolerated
                    -- during the transition; see the header.
                    WHEN NULLIF((((SELECT auth.jwt()) -> 'app_metadata') ->> 'session_version'), '') IS NULL
                        THEN true
                    ELSE a.session_version =
                         NULLIF((((SELECT auth.jwt()) -> 'app_metadata') ->> 'session_version'), '')::integer
                END
            FROM public.accounts a
            WHERE a.auth_user_id = (SELECT auth.uid()) AND a.status = 'active'
            LIMIT 1
        ),
        false
    );
$$;

COMMENT ON FUNCTION public.gm_session_is_valid() IS
    'True when the caller''s token epoch still matches accounts.session_version. Absent claim = legacy token, tolerated during the Discord migration; stale claim = revoked. Invoked by the six RLS helper functions below, which together back 77 policy references -- folding it in there rather than editing every policy is what made this a small change.';

-- ── 3. Fold it into the helpers the policies actually call ────────────────
-- 77 policy references across six functions, versus editing 100+ policies.
CREATE OR REPLACE FUNCTION public.gm_is_admin_caller()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT public.gm_session_is_valid() AND EXISTS (
        SELECT 1 FROM public.accounts
        WHERE auth_user_id = auth.uid() AND status = 'active'
          AND role IN ('super_admin', 'server_admin', 'guild_admin')
    );
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN RETURN false; END IF;
    IF NOT public.gm_session_is_valid() THEN RETURN false; END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = v_auth_id AND a.status = 'active' AND a.role = 'super_admin'
        LIMIT 1
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_can_read_guilds()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN RETURN false; END IF;
    IF NOT public.gm_session_is_valid() THEN RETURN false; END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
          AND a.role IN ('super_admin', 'server_admin', 'guild_admin')
        LIMIT 1
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_user_guild_access(p_guild text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text; v_guild text; v_server text; v_target_server text;
BEGIN
  IF p_guild IS NULL OR p_guild = '' THEN RETURN false; END IF;
  IF NOT public.gm_session_is_valid() THEN RETURN false; END IF;

  SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
  INTO v_role, v_guild, v_server
  FROM public.accounts a
  LEFT JOIN public.guilds g ON g.id = a.guild
  WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
  LIMIT 1;

  IF v_role IS NULL THEN RETURN false; END IF;
  IF v_role = 'super_admin' THEN RETURN true; END IF;

  IF v_role = 'server_admin' THEN
    IF v_server IS NOT NULL THEN
      SELECT g2.server_number INTO v_target_server FROM public.guilds g2 WHERE g2.id = p_guild;
      RETURN (v_target_server IS NOT NULL AND v_target_server = v_server);
    END IF;
    RETURN false;
  END IF;

  IF v_role = 'guild_admin' THEN
    RETURN (v_guild IS NOT NULL AND v_guild = p_guild);
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_user_guild_write_access(p_guild text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_auth_id uuid; v_role text; v_guild text; v_server_number text; v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN RETURN false; END IF;
    IF NOT public.gm_session_is_valid() THEN RETURN false; END IF;

    IF public.is_super_admin() THEN RETURN true; END IF;

    SELECT a.role, a.guild, a.server_number INTO v_role, v_guild, v_server_number
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role IS NULL THEN RETURN false; END IF;

    IF v_role = 'server_admin' THEN
        IF v_server_number IS NOT NULL THEN
            SELECT g.server_number INTO v_target_server FROM public.guilds g WHERE g.id = p_guild;
            RETURN (v_target_server IS NOT NULL AND v_target_server = v_server_number);
        END IF;
        RETURN false;
    END IF;

    IF v_role IN ('guild_admin', 'R4') THEN
        RETURN (v_guild IS NOT NULL AND v_guild = p_guild);
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_can_read_guild_data(p_guild text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_auth_id uuid; v_role text; v_guild text; v_server_number text; v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN RETURN false; END IF;
    IF NOT public.gm_session_is_valid() THEN RETURN false; END IF;

    IF public.is_super_admin() THEN RETURN true; END IF;

    SELECT a.role, a.guild, a.server_number INTO v_role, v_guild, v_server_number
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role IS NULL THEN RETURN false; END IF;

    IF v_role = 'server_admin' THEN
        IF v_server_number IS NOT NULL THEN
            SELECT g.server_number INTO v_target_server FROM public.guilds g WHERE g.id = p_guild;
            RETURN (v_target_server IS NOT NULL AND v_target_server = v_server_number);
        END IF;
        RETURN false;
    END IF;

    IF v_role IN ('guild_admin', 'R4') THEN
        RETURN (v_guild IS NOT NULL AND v_guild = p_guild);
    END IF;

    RETURN false;
END;
$$;

-- ── 4. Assertions ─────────────────────────────────────────────────────────
DO $verify$
DECLARE
    v_missing int;
    v_n       int;
BEGIN
    SELECT count(*) INTO v_missing
    FROM auth.users u JOIN public.accounts a ON a.auth_user_id = u.id
    WHERE NOT (COALESCE(u.raw_app_meta_data, '{}'::jsonb) ? 'session_version');
    IF v_missing <> 0 THEN
        RAISE EXCEPTION '% linked users still lack the session_version claim', v_missing;
    END IF;

    -- Every helper the policies call must now consult the epoch.
    SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('gm_is_admin_caller', 'is_super_admin', 'gm_can_read_guilds',
                        'check_user_guild_access', 'check_user_guild_write_access', 'gm_can_read_guild_data')
      AND pg_get_functiondef(p.oid) ~ 'gm_session_is_valid';
    IF v_n <> 6 THEN
        RAISE EXCEPTION 'only % of 6 RLS helpers consult gm_session_is_valid', v_n;
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
