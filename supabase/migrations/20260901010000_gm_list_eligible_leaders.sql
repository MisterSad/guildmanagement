-- 20260901010000_gm_list_eligible_leaders.sql
--
-- Found during a live stabilization sweep: gm-leader-hall.js's
-- fetchEligibleLeaders() queried public.accounts directly from the client
-- (`.from('accounts').select('id, guild, role, server_number')`), relying
-- on RLS to scope the result. The actual SELECT policy on public.accounts
-- (gm_can_read_account) only allows super_admin to read every row — every
-- other role can only read their OWN row. In practice this meant the
-- Leader Hall's "New Chat" / "New Group" / "Propose Treaty" leader picker
-- was empty for every guild_admin, server_admin, R4, and R5 account (i.e.
-- everyone except the single super_admin) — they could receive messages
-- in a conversation someone else started, but could never see another
-- leader to start one themselves.
--
-- The fix is a dedicated RPC rather than loosening accounts' RLS: accounts
-- holds password_hash / gotrue_secret_enc / auth_user_id — broadening the
-- SELECT policy so any admin can read other rows would leak those. This
-- function returns only the four safe fields the leader picker actually
-- needs, and is itself gated so only an already-eligible leader can call
-- it (mirrors the feature's own access scope: "for Guild Masters (R5) and
-- Officers (R4)", not every authenticated account).

CREATE OR REPLACE FUNCTION public.gm_list_eligible_leaders()
RETURNS TABLE(id text, guild text, role text, server_number text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
BEGIN
    SELECT a.role INTO v_caller_role
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin') THEN
        RETURN; -- not an eligible leader: empty result, same shape as "no one found"
    END IF;

    RETURN QUERY
    SELECT a.id, a.guild, a.role, a.server_number
    FROM public.accounts a
    WHERE a.status = 'active'
      AND a.role IN ('super_admin', 'server_admin', 'guild_admin', 'R5', 'R4', 'admin')
    ORDER BY a.guild ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_list_eligible_leaders() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_eligible_leaders() TO authenticated;

NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
DROP FUNCTION IF EXISTS public.gm_list_eligible_leaders();
*/
