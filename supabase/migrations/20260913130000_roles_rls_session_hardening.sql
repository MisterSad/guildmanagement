-- 20260913130000_roles_rls_session_hardening.sql
-- Phase 2 audit remediation (read-only diagnostic findings H1-H4, M2, M4):
--   * H1/H2/H3/H4: remove the legacy role aliases that equated 'R5'/'admin'
--     with global super_admin access and 'R4' with guild-level access. The
--     accounts role set is now strictly the canonical four roles, and the
--     authorization helpers resolve explicitly from public.accounts.
--   * M2: player_absences self-read policy resolves through public.accounts
--     (a.uid = player_absences.uid) instead of the app_metadata claim.
--   * M4: groundwork for session invalidation -- an accounts.session_version
--     epoch plus public.gm_session_is_valid() comparing it against the JWT
--     app_metadata claim 'session_version' (stamped by the shadow-session
--     minting path on every login / account event).
--
-- PRECONDITION (verified by ops): public.accounts contains no legacy
-- 'R5'/'R4'/'admin' rows. If any exists, the strict CHECK below fails on
-- purpose -- do not delete such rows silently, review ownership first.

-- ============================================================
-- 1. STRICT ROLE CONSTRAINT
-- ============================================================
-- Also fixes the legacy DEFAULT ('R4') so a bare insert cannot reintroduce a
-- value outside the canonical set.
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('super_admin', 'server_admin', 'guild_admin', 'member'));
ALTER TABLE public.accounts ALTER COLUMN role SET DEFAULT 'member';

-- ============================================================
-- 2. AUTHORIZATION HELPERS -- EXACT ROLES, ZERO ALIASES
-- ============================================================
-- Each helper resolves the caller from public.accounts (auth_user_id +
-- status = 'active') and matches the EXACT canonical role only.

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = v_auth_id
          AND a.status = 'active'
          AND a.role = 'super_admin'
        LIMIT 1
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_server_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = v_auth_id
          AND a.status = 'active'
          AND a.role IN ('super_admin', 'server_admin')
        LIMIT 1
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_can_read_guilds()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = v_auth_id
          AND a.status = 'active'
          AND a.role IN ('super_admin', 'server_admin', 'guild_admin')
        LIMIT 1
    );
END;
$function$;

-- ============================================================
-- 3. SESSION INVALIDATION (M4)
-- ============================================================
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;

-- True when the caller's JWT app_metadata.session_version matches the account's
-- current session_version. Bumped on password reset / role change / suspension;
-- tokens issued before a bump (stale claims) fail this gate on any policy that
-- invokes it. Also refuses suspended/deleted accounts (status != 'active').
CREATE OR REPLACE FUNCTION public.gm_session_is_valid()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.auth_user_id = (SELECT auth.uid())
          AND a.status = 'active'
          AND a.session_version =
              NULLIF((((SELECT auth.jwt()) -> 'app_metadata') ->> 'session_version'), '')::integer
        LIMIT 1
    );
$function$;

REVOKE ALL ON FUNCTION public.gm_session_is_valid() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_session_is_valid() TO authenticated;

-- ============================================================
-- 4. PLAYER ABSENCES SELF-READ THROUGH ACCOUNTS (M2)
-- ============================================================
DROP POLICY IF EXISTS player_absences_select_policy ON public.player_absences;
CREATE POLICY player_absences_select_policy ON public.player_absences
    FOR SELECT TO authenticated
    USING (
        public.gm_can_admin_see_absences(guild)
        OR EXISTS (
            SELECT 1 FROM public.accounts a
            WHERE a.auth_user_id = (SELECT auth.uid())
              AND a.status = 'active'
              AND a.uid = player_absences.uid
        )
    );

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL (restores Phase-1 state):
ALTER TABLE public.accounts ALTER COLUMN role SET DEFAULT 'R4';
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('super_admin', 'server_admin', 'guild_admin', 'member', 'R5', 'R4', 'admin'));
ALTER TABLE public.accounts DROP COLUMN IF EXISTS session_version;
DROP FUNCTION IF EXISTS public.gm_session_is_valid();
DROP FUNCTION IF EXISTS public.is_super_admin();
DROP FUNCTION IF EXISTS public.is_server_admin();
DROP FUNCTION IF EXISTS public.gm_can_read_guilds();
NOTIFY pgrst, 'reload schema';
*/