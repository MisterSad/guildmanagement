-- A member in Adelaide, Darwin, India, Nepal, Iran, Afghanistan, Myanmar or
-- Newfoundland cannot save their timezone. Reported as TICKET-0010 (LZGD,
-- 2026-09-30):
--
--     Admin portal:   invalid input syntax for type integer: "9.5"
--     Player portal:  Failed to save: invalid_payload
--
-- Both are the same defect. `guild_members.timezone_offset` was declared
-- INTEGER in 20260812000001, while every writer computes the offset with
-- `getTimezoneOffset()` (src/utils/timezone.ts), which returns +9.5 for
-- Australia/Adelaide, +5.5 for Asia/Kolkata, +5.75 for Asia/Kathmandu. The
-- admin edit writes the column directly and Postgres rejects the literal; the
-- player portal is stopped one step earlier by `UpdateTimezoneSchema`, which
-- demanded `.int()`. `COMMON_TIMEZONES` offers both of those zones, so the UI
-- has been offering choices the database refuses.
--
-- Measured before this migration: 154 rows carry an offset, all integral,
-- min -10, max 10, and none of them has a half-hour IANA zone -- nobody has
-- ever managed to store one.
--
-- Real-world offsets are multiples of a quarter hour (Nepal +5:45, Chatham
-- +12:45/+13:45), so the column becomes numeric(4,2) with a quarter-hour CHECK.
-- Existing integer values convert losslessly.
--
-- Dependents found by scanning pg_get_functiondef for `timezone_offset|p_offset`:
--   gm_update_player_timezone(text, integer)        -- stale overload, dropped
--   gm_update_player_timezone(text, integer, text)  -- recreated as numeric
--   gm_reset_demo_tenant_data()                     -- writes integer literals; unaffected
--   gm_erase_player(text, text)                     -- writes NULL; unaffected
-- No view reads the column.

ALTER TABLE public.guild_members
  DROP CONSTRAINT IF EXISTS guild_members_timezone_offset_check;

ALTER TABLE public.guild_members
  ALTER COLUMN timezone_offset TYPE numeric(4,2) USING timezone_offset::numeric(4,2);

ALTER TABLE public.guild_members
  ADD CONSTRAINT guild_members_timezone_offset_check CHECK (
    timezone_offset IS NULL
    OR (timezone_offset BETWEEN -12 AND 14 AND timezone_offset * 4 = trunc(timezone_offset * 4))
  );

-- The parameter type is part of the signature: CREATE OR REPLACE would add a
-- third overload and PostgREST would then refuse the call as ambiguous.
DROP FUNCTION IF EXISTS public.gm_update_player_timezone(text, integer);
DROP FUNCTION IF EXISTS public.gm_update_player_timezone(text, integer, text);

CREATE OR REPLACE FUNCTION public.gm_update_player_timezone(
  p_uid text,
  p_offset numeric,
  p_timezone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_offset IS NULL OR p_offset < -12 OR p_offset > 14 OR p_offset * 4 <> trunc(p_offset * 4) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_offset');
  END IF;

  UPDATE public.guild_members
  SET timezone_offset = p_offset,
      timezone = COALESCE(p_timezone, timezone)
  WHERE uid = p_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_update_player_timezone(text, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_update_player_timezone(text, numeric, text) TO service_role;

NOTIFY pgrst, 'reload schema';
