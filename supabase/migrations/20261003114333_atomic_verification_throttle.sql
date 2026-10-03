-- 20261003114333_atomic_verification_throttle.sql
--
-- Short-term plan, phase 3 (audit SEC-12, BE-A-12, AGENTS.md rule 7).
--
-- discord-profile-verification budgets each Discord user before calling a
-- metered vision API. Its limiter read the window, then wrote the bucket in a
-- second round trip (two concurrent posts both passed), and returned
-- "allowed" on any database error. This is the same atomic shape as
-- gm_check_ip_throttle and gm_check_discord_throttle, on the verification
-- table: the SUM and the increment happen in one statement's transaction, and
-- the caller now fails closed.

CREATE OR REPLACE FUNCTION public.gm_check_verification_throttle(
  p_discord_user_id text, p_limit integer, p_window_ms bigint, p_bucket timestamptz
)
RETURNS TABLE(allowed boolean, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_total integer;
BEGIN
    SELECT COALESCE(SUM(t.attempts), 0) INTO v_total
    FROM public.discord_verification_throttle t
    WHERE t.discord_user_id = p_discord_user_id
      AND t.window_start >= p_bucket - make_interval(secs => (p_window_ms / 1000.0)::double precision);

    IF v_total >= p_limit THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    INSERT INTO public.discord_verification_throttle (discord_user_id, window_start, attempts)
    VALUES (p_discord_user_id, p_bucket, 1)
    ON CONFLICT (discord_user_id, window_start) DO UPDATE
        SET attempts = public.discord_verification_throttle.attempts + 1;

    RETURN QUERY SELECT true, GREATEST(0, p_limit - (v_total + 1));
END;
$$;

REVOKE ALL ON FUNCTION public.gm_check_verification_throttle(text, integer, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_verification_throttle(text, integer, bigint, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
