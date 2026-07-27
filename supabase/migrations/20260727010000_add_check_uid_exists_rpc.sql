-- Migration: Add check_uid_exists_globally RPC function
-- Allows checking if a UID exists anywhere in the system to prevent duplicates across guilds.

CREATE OR REPLACE FUNCTION public.check_uid_exists_globally(p_uid text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.guild_members WHERE uid = p_uid
    ) INTO v_exists;
    
    RETURN v_exists;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_uid_exists_globally(text) TO authenticated;
