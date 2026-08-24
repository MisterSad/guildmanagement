-- 20260824122000_fix_tickets_service_role_rpc.sql
-- Workstream: Fix tickets listing & status update when called from service role (tickets Edge Function)
--
-- Root cause: gm_list_tickets and gm_update_ticket_status guarded caller access via
-- public.is_super_admin(). When invoked from the tickets Edge Function using the SERVICE ROLE key,
-- auth.uid() is NULL in Postgres, causing is_super_admin() to evaluate to false.
-- This returned an empty array [] on list and 'forbidden' on status update.
--
-- Fix: Allow service-role calls (auth.uid() IS NULL) while preserving strict super_admin
-- enforcement when called directly with an authenticated JWT (auth.uid() IS NOT NULL).
-- The Edge Function already enforces caller.role === 'super_admin' server-side via validateCallerAuth.

-- 1. List tickets (service-role safe + browser super-admin gated)
CREATE OR REPLACE FUNCTION public.gm_list_tickets()
RETURNS TABLE(
    id bigint,
    ticket_number bigint,
    guild text,
    reporter_account_id text,
    reporter_role text,
    title text,
    description text,
    category text,
    severity text,
    status text,
    created_at timestamptz,
    resolved_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT t.id, t.ticket_number, t.guild, t.reporter_account_id, t.reporter_role,
           t.title, t.description, t.category, t.severity, t.status, t.created_at, t.resolved_at
    FROM public.tickets t
    WHERE (auth.uid() IS NULL OR public.is_super_admin())
    ORDER BY t.ticket_number DESC;
$$;

REVOKE ALL ON FUNCTION public.gm_list_tickets() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_tickets() TO authenticated, service_role;

-- 2. Update ticket status (service-role safe + browser super-admin gated)
CREATE OR REPLACE FUNCTION public.gm_update_ticket_status(
    p_id bigint,
    p_status text
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    -- Internal authorization gate when called with an authenticated JWT (browser path).
    -- Service-role calls (tickets Edge Function) are trusted: the Edge already enforced
    -- that caller.role === 'super_admin'.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.is_super_admin() THEN
            RETURN QUERY SELECT false, 'forbidden'::text;
            RETURN;
        END IF;
    END IF;

    IF p_status NOT IN ('open', 'resolved', 'closed') THEN
        RETURN QUERY SELECT false, 'invalid_status'::text;
        RETURN;
    END IF;

    UPDATE public.tickets
    SET status = p_status,
        resolved_at = CASE WHEN p_status IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) ELSE NULL END
    WHERE id = p_id;

    RETURN QUERY SELECT true, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_update_ticket_status(bigint, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_update_ticket_status(bigint, text) TO authenticated, service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- Reverts to previous version from 20260824113700_tickets.sql
CREATE OR REPLACE FUNCTION public.gm_list_tickets()
RETURNS TABLE(
    id bigint,
    ticket_number bigint,
    guild text,
    reporter_account_id text,
    reporter_role text,
    title text,
    description text,
    category text,
    severity text,
    status text,
    created_at timestamptz,
    resolved_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT t.id, t.ticket_number, t.guild, t.reporter_account_id, t.reporter_role,
           t.title, t.description, t.category, t.severity, t.status, t.created_at, t.resolved_at
    FROM public.tickets t
    WHERE public.is_super_admin()
    ORDER BY t.ticket_number DESC;
$$;

CREATE OR REPLACE FUNCTION public.gm_update_ticket_status(
    p_id bigint,
    p_status text
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN QUERY SELECT false, 'forbidden'::text;
        RETURN;
    END IF;

    IF p_status NOT IN ('open', 'resolved', 'closed') THEN
        RETURN QUERY SELECT false, 'invalid_status'::text;
        RETURN;
    END IF;

    UPDATE public.tickets
    SET status = p_status,
        resolved_at = CASE WHEN p_status IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) ELSE NULL END
    WHERE id = p_id;

    RETURN QUERY SELECT true, NULL::text;
END;
$$;
*/
