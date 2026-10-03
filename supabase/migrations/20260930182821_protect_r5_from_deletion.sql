-- The R5 leader could be deleted by a Members OCR scan.
--
-- Found 2026-09-30. A Members OCR scan lists every roster member it did not
-- see under "Removed Members", ticked for removal by default on a full scan --
-- the R5 included. The leader missing from one screenshot was enough for one
-- confirmation to delete their row, and with it (ON DELETE CASCADE) every
-- participation, squad, weekly score and sanction they had. The client now
-- never lists or sends an R5 for removal; this is the database half, so no
-- other path (a stale bundle, the single Delete button, a direct REST call)
-- can do it either.
--
-- Rule: a row whose role is R5 cannot be deleted from a user session unless the
-- caller is a super_admin. Handing leadership over is unchanged: a guild's own
-- admins can change the R5's role (20260930110000) and then remove them.
--
-- Session-less paths are deliberately untouched -- `auth.uid()` is NULL there:
-- the nightly DEMO reset (`gm_reset_demo_tenant_data`, pg_cron) deletes the
-- DEMO roster wholesale, and `gm_expire_empty_guilds` only deletes guilds with
-- no members. `gm_delete_guild` is super_admin only.

CREATE OR REPLACE FUNCTION public.gm_protect_r5_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.role = 'R5'
     AND auth.uid() IS NOT NULL
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'r5_delete_forbidden'
      USING ERRCODE = '42501',
            HINT = 'Change the R5 leader''s role first, then remove them.';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS gm_guild_members_protect_r5_delete ON public.guild_members;
CREATE TRIGGER gm_guild_members_protect_r5_delete
  BEFORE DELETE ON public.guild_members
  FOR EACH ROW
  EXECUTE FUNCTION public.gm_protect_r5_deletion();

-- A trigger function is never an API endpoint.
REVOKE EXECUTE ON FUNCTION public.gm_protect_r5_deletion() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
