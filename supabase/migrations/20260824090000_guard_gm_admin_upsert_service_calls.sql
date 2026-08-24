-- 20260824090000_guard_gm_admin_upsert_service_calls.sql
-- Workstream: fix server_error on admin account creation (2026-08-24 incident)
--
-- Root cause: the v124.1 RPC lockdown gave gm_admin_upsert an unconditional
-- caller-authorization gate (is_super_admin / check_user_guild_write_access).
-- Its only production caller is the admin-accounts Edge Function, which
-- invokes it with the SERVICE ROLE key: auth.uid() is NULL inside the RPC,
-- the gate resolves no caller, and raises 'Access denied' -> the Edge maps
-- the RPC error to "server_error". Account creation has been broken on live
-- since the lockdown deployment; the guild itself was created through a
-- different path, which is why guild creation worked while admin creation
-- failed.
--
-- Fix: mirror the established service-safe pattern already used by
-- gm_upsert_player_metrics and gm_reset_account_password in the same lockdown
-- migration: enforce the gate only when called with an authenticated JWT
-- (browser path). Service-role calls are trusted; the Edge Function remains
-- the authorization point (getCallerInfo + _shared/admin-authz matrix).

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(
    p_id text,
    p_password text,
    p_role text,
    p_guild text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    -- Internal authorization gate when called with an authenticated JWT
    -- (browser path). Service-role calls (admin-accounts Edge Function) are
    -- trusted: the Edge already enforced the caller's role and guild scope.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.is_super_admin() THEN
            IF p_role IN ('super_admin', 'server_admin') THEN
                RAISE EXCEPTION 'forbidden';
            END IF;
            IF NOT public.check_user_guild_write_access(p_guild) THEN
                RAISE EXCEPTION 'Access denied';
            END IF;
        END IF;
    END IF;

    INSERT INTO public.accounts (id, role, password_enc, guild, status, created_at)
    VALUES (
        TRIM(p_id),
        COALESCE(p_role, 'guild_admin'),
        extensions.pgp_sym_encrypt(p_password, (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
        p_guild,
        'active',
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        password_enc = EXCLUDED.password_enc,
        guild = EXCLUDED.guild,
        status = 'active';
END;
$$;

REVOKE ALL ON FUNCTION public.gm_admin_upsert(text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_admin_upsert(text, text, text, text) TO authenticated, service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- Restore the previous body (unconditional gate) from
-- 20260823060000_security_rpc_lockdown.sql section 3.
*/
