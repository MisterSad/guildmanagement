-- 20260812042000_add_gm_delete_guild_rpc.sql
--
-- RPC for Super Admins to permanently delete a tenant (guild) and all its
-- associated data (members, events, squads, transfers, configs, non-super-admin accounts).

CREATE OR REPLACE FUNCTION public.gm_delete_guild(p_guild_id text)
 RETURNS TABLE(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_guild_id IS NULL OR trim(p_guild_id) = '' THEN
    RETURN QUERY SELECT false, 'missing_guild_id';
    RETURN;
  END IF;

  -- Security check: only super_admin can delete a tenant/guild
  IF NOT public.is_super_admin() THEN
    RETURN QUERY SELECT false, 'unauthorized';
    RETURN;
  END IF;

  -- Check if guild exists
  IF NOT EXISTS (SELECT 1 FROM public.guilds WHERE id = trim(p_guild_id)) THEN
    RETURN QUERY SELECT false, 'guild_not_found';
    RETURN;
  END IF;

  -- Delete all associated tenant data atomically
  DELETE FROM public.event_participants WHERE guild = trim(p_guild_id);
  DELETE FROM public.event_status WHERE guild = trim(p_guild_id);
  DELETE FROM public.shadowfront_squads WHERE guild = trim(p_guild_id);
  DELETE FROM public.guild_transfers WHERE source_guild = trim(p_guild_id) OR target_guild = trim(p_guild_id);
  DELETE FROM public.guild_config WHERE guild = trim(p_guild_id);
  DELETE FROM public.guild_members WHERE guild = trim(p_guild_id);
  DELETE FROM public.accounts WHERE guild = trim(p_guild_id) AND (role IS NULL OR role <> 'super_admin');
  DELETE FROM public.guilds WHERE id = trim(p_guild_id);

  RETURN QUERY SELECT true, null::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_delete_guild(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_delete_guild(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
