-- 20260824124500_ticket_statuses.sql
-- Workstream: Support 4 ticket statuses (waiting, in_progress, resolved, closed) with default 'waiting'
-- and return ticket metadata on status update for Discord notification.

-- 1. Alter default status column
ALTER TABLE public.tickets ALTER COLUMN status SET DEFAULT 'waiting';

-- 2. Update existing 'open' tickets to 'waiting' if any exist
UPDATE public.tickets SET status = 'waiting' WHERE status = 'open';

-- 3. Drop existing gm_update_ticket_status to allow updated return signature
DROP FUNCTION IF EXISTS public.gm_update_ticket_status(bigint, text);

-- 4. Update gm_create_ticket to default to 'waiting'
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
        'waiting',
        v_attachments
    )
    RETURNING tickets.id, tickets.ticket_number, tickets.status
    INTO v_ticket_id, v_ticket_number, v_status;

    RETURN QUERY SELECT v_ticket_number, v_ticket_id, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text, jsonb) TO authenticated, service_role;

-- 5. Create updated gm_update_ticket_status returning rich ticket details
CREATE OR REPLACE FUNCTION public.gm_update_ticket_status(
    p_id bigint,
    p_status text
)
RETURNS TABLE(
    ok boolean,
    error text,
    ticket_number bigint,
    title text,
    category text,
    severity text,
    guild text,
    reporter_account_id text,
    old_status text,
    new_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_norm_status text;
    v_old_status text;
    v_ticket_no bigint;
    v_title text;
    v_category text;
    v_severity text;
    v_guild text;
    v_reporter text;
BEGIN
    -- Internal authorization gate when called with an authenticated JWT (browser path).
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.is_super_admin() THEN
            RETURN QUERY SELECT false, 'forbidden'::text, NULL::bigint, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text;
            RETURN;
        END IF;
    END IF;

    -- Normalize status ('open' -> 'waiting')
    v_norm_status := CASE WHEN p_status = 'open' THEN 'waiting' ELSE p_status END;

    IF v_norm_status NOT IN ('waiting', 'in_progress', 'resolved', 'closed') THEN
        RETURN QUERY SELECT false, 'invalid_status'::text, NULL::bigint, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text;
        RETURN;
    END IF;

    -- Fetch current row
    SELECT t.ticket_number, t.title, t.category, t.severity, t.guild, t.reporter_account_id, t.status
    INTO v_ticket_no, v_title, v_category, v_severity, v_guild, v_reporter, v_old_status
    FROM public.tickets t
    WHERE t.id = p_id;

    IF v_ticket_no IS NULL THEN
        RETURN QUERY SELECT false, 'ticket_not_found'::text, NULL::bigint, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text;
        RETURN;
    END IF;

    UPDATE public.tickets
    SET status = v_norm_status,
        resolved_at = CASE WHEN v_norm_status IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) ELSE NULL END
    WHERE id = p_id;

    RETURN QUERY SELECT
        true,
        NULL::text,
        v_ticket_no,
        v_title,
        v_category,
        v_severity,
        v_guild,
        v_reporter,
        v_old_status,
        v_norm_status;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_update_ticket_status(bigint, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_update_ticket_status(bigint, text) TO authenticated, service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
