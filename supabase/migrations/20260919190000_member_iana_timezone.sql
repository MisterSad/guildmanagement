-- ==============================================================================
-- Migration: 20260919190000_member_iana_timezone.sql
-- Description: Add IANA timezone support to guild_members and update
--              gm_update_player_timezone RPC with p_timezone parameter.
-- ==============================================================================

-- 1. Add timezone column to guild_members if not exists
ALTER TABLE public.guild_members
  ADD COLUMN IF NOT EXISTS timezone text;

-- 2. Update gm_update_player_timezone RPC to support p_timezone
CREATE OR REPLACE FUNCTION public.gm_update_player_timezone(
  p_uid text,
  p_offset integer,
  p_timezone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_offset IS NULL OR p_offset < -12 OR p_offset > 14 THEN
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

-- 3. Enforce Zero-Trust security permissions
REVOKE ALL ON FUNCTION public.gm_update_player_timezone(text, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_update_player_timezone(text, integer, text) TO service_role;

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
