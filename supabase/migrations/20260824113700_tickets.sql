-- 20260824113700_tickets.sql
-- Workstream: Bug-Reporting Ticketing System (V3.5.3)
--
-- Any guild_admin / server_admin / super_admin can report a bug from the app.
-- Tickets are app-level (guild-attributed but not guild-scoped, modeled on
-- gm_payments): RLS is enabled with NO public policies, so access is only via
-- the SECURITY DEFINER RPCs below. Ticket numbers are a single global sequence
-- (the table's identity id), formatted #TICKET-xxxx in the UI/Discord embed.

-- 1. Tickets table
CREATE TABLE IF NOT EXISTS public.tickets (
    id BIGSERIAL PRIMARY KEY,
    ticket_number BIGINT NOT NULL,
    guild TEXT REFERENCES public.guilds(id) ON DELETE CASCADE,
    reporter_account_id TEXT NOT NULL,
    reporter_role TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'bug',
    severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON public.tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON public.tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_guild ON public.tickets (guild);

-- 2. Helper: resolve the caller's admin role (any of the 3 admin roles; member
--    and anonymous callers are rejected).
CREATE OR REPLACE FUNCTION public.gm_is_admin_caller()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.accounts
        WHERE auth_user_id = auth.uid() AND status = 'active'
          AND role IN ('super_admin', 'server_admin', 'guild_admin')
    );
$$;

REVOKE ALL ON FUNCTION public.gm_is_admin_caller() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_is_admin_caller() TO authenticated;

-- 3. Create ticket (browser + service-role safe)
CREATE OR REPLACE FUNCTION public.gm_create_ticket(
    p_title text,
    p_description text,
    p_category text DEFAULT 'bug',
    p_severity text DEFAULT 'medium',
    p_guild text DEFAULT NULL,
    p_reporter_account_id text DEFAULT NULL,
    p_reporter_role text DEFAULT NULL
)
RETURNS TABLE(ticket_number bigint, id bigint, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_reporter_account text;
    v_reporter_role text;
    v_ticket_id bigint;
    v_ticket_number bigint;
    v_status text;
    v_title text;
    v_description text;
BEGIN
    IF p_title IS NULL OR length(trim(p_title)) = 0 THEN
        RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'missing_title'::text;
        RETURN;
    END IF;
    IF p_description IS NULL OR length(trim(p_description)) = 0 THEN
        RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'missing_description'::text;
        RETURN;
    END IF;

    v_title := left(trim(p_title), 120);
    v_description := left(trim(p_description), 4000);

    -- Browser path (authenticated JWT): resolve the reporter from accounts and
    -- enforce the 3-admin-role gate. Any caller-supplied reporter params are
    -- IGNORED here so a browser user cannot forge attribution.
    IF auth.uid() IS NOT NULL THEN
        SELECT a.id, a.role INTO v_reporter_account, v_reporter_role
        FROM public.accounts a
        WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
        LIMIT 1;
        IF v_reporter_account IS NULL OR v_reporter_role NOT IN ('super_admin', 'server_admin', 'guild_admin') THEN
            RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'forbidden'::text;
            RETURN;
        END IF;
    ELSE
        -- Service-role path (tickets Edge Function): the Edge has already
        -- resolved and authorized the caller; trust its explicit reporter.
        v_reporter_account := p_reporter_account_id;
        v_reporter_role := p_reporter_role;
        IF v_reporter_account IS NULL OR v_reporter_role NOT IN ('super_admin', 'server_admin', 'guild_admin') THEN
            RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'forbidden'::text;
            RETURN;
        END IF;
    END IF;

    INSERT INTO public.tickets (
        ticket_number, guild, reporter_account_id, reporter_role,
        title, description, category, severity, status
    )
    VALUES (
        nextval(pg_get_serial_sequence('public.tickets', 'id')),
        NULLIF(p_guild, ''),
        v_reporter_account, v_reporter_role,
        v_title, v_description,
        COALESCE(NULLIF(p_category, ''), 'bug'),
        COALESCE(NULLIF(p_severity, ''), 'medium'),
        'open'
    )
    RETURNING tickets.id, tickets.ticket_number, tickets.status
    INTO v_ticket_id, v_ticket_number, v_status;

    RETURN QUERY SELECT v_ticket_number, v_ticket_id, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text) TO authenticated, service_role;

-- 4. List tickets (super admin only; super_admin can see all, admins see none
--    via this RPC since the Tickets tab is super-admin gated client-side)
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

REVOKE ALL ON FUNCTION public.gm_list_tickets() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_tickets() TO authenticated, service_role;

-- 5. Update ticket status (super admin only)
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

REVOKE ALL ON FUNCTION public.gm_update_ticket_status(bigint, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_update_ticket_status(bigint, text) TO authenticated, service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
DROP TABLE IF EXISTS public.tickets;
DROP FUNCTION IF EXISTS public.gm_is_admin_caller();
DROP FUNCTION IF EXISTS public.gm_create_ticket(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.gm_list_tickets();
DROP FUNCTION IF EXISTS public.gm_update_ticket_status(bigint, text);
*/
