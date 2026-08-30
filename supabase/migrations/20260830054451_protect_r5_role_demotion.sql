-- R-01 audit fix: the R5-leader protection added in gm-utils.js
-- (filterBulkEligibleMembers, ALLOWED_BULK_ROLES) only filters the bulk
-- rank-assignment UI. The gm_authenticated_update RLS policy on
-- guild_members only checks guild scoping (check_user_guild_write_access),
-- with no role check — so a guild_admin/server_admin could still change an
-- R5's role directly via the REST/PostgREST API, bypassing the UI entirely.
--
-- RLS policies can't see old vs. new column values, so this is enforced with
-- a trigger instead: only super_admin may change the `role` of a row that is
-- currently R5. Non-role field updates (stat sync, roster import) on an R5
-- row are untouched.

CREATE OR REPLACE FUNCTION public.gm_protect_r5_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.role = 'R5'
     AND NEW.role IS DISTINCT FROM OLD.role
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'r5_role_change_forbidden'
      USING ERRCODE = '42501',
            HINT = 'Only a super_admin can change the role of an R5 guild leader.';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS gm_guild_members_protect_r5 ON public.guild_members;
CREATE TRIGGER gm_guild_members_protect_r5
  BEFORE UPDATE ON public.guild_members
  FOR EACH ROW
  EXECUTE FUNCTION public.gm_protect_r5_role_change();

NOTIFY pgrst, 'reload schema';
