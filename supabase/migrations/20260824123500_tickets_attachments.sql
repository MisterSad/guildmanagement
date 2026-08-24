-- 20260824123500_tickets_attachments.sql
-- Workstream: Add screenshot attachments support to tickets system (V3.5.5)

-- 1. Add attachments column to public.tickets table
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;

-- 2. Drop old signatures to allow updated parameters and return table types
DROP FUNCTION IF EXISTS public.gm_create_ticket(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.gm_create_ticket(text, text, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.gm_list_tickets();

-- 3. Create ticket with attachments parameter
CREATE OR REPLACE FUNCTION public.gm_create_ticket(
    p_title text,
    p_description text,
    p_category text DEFAULT 'bug',
    p_severity text DEFAULT 'medium',
    p_guild text DEFAULT NULL,
    p_reporter_account_id text DEFAULT NULL,
    p_reporter_role text DEFAULT NULL,
    p_attachments jsonb DEFAULT '[]'::jsonb
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
    v_attachments jsonb;
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
    v_attachments := COALESCE(p_attachments, '[]'::jsonb);

    -- Browser path (authenticated JWT): resolve the reporter from accounts and
    -- enforce the 3-admin-role gate.
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

    v_ticket_number := nextval(pg_get_serial_sequence('public.tickets', 'id'));

    INSERT INTO public.tickets (
        id, ticket_number, guild, reporter_account_id, reporter_role,
        title, description, category, severity, status, attachments
    )
    VALUES (
        v_ticket_number,
        v_ticket_number,
        NULLIF(p_guild, ''),
        v_reporter_account, v_reporter_role,
        v_title, v_description,
        COALESCE(NULLIF(p_category, ''), 'bug'),
        COALESCE(NULLIF(p_severity, ''), 'medium'),
        'open',
        v_attachments
    )
    RETURNING tickets.id, tickets.ticket_number, tickets.status
    INTO v_ticket_id, v_ticket_number, v_status;

    RETURN QUERY SELECT v_ticket_number, v_ticket_id, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text, jsonb) TO authenticated, service_role;

-- 4. Update gm_list_tickets to return attachments
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
    resolved_at timestamptz,
    attachments jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT t.id, t.ticket_number, t.guild, t.reporter_account_id, t.reporter_role,
           t.title, t.description, t.category, t.severity, t.status, t.created_at, t.resolved_at,
           COALESCE(t.attachments, '[]'::jsonb) AS attachments
    FROM public.tickets t
    WHERE (auth.uid() IS NULL OR public.is_super_admin())
    ORDER BY t.ticket_number DESC;
$$;

REVOKE ALL ON FUNCTION public.gm_list_tickets() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_tickets() TO authenticated, service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
ALTER TABLE public.tickets DROP COLUMN IF EXISTS attachments;
*/
