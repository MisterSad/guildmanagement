-- 20260812045500_clean_obsolete_nightwraith_members.sql
--
-- Remove old/obsolete member records from NIGHTWRAITH tenant that were not part
-- of the 147 members update list (e.g. old pseudos, case differences, renamed players).

DELETE FROM public.guild_members
WHERE guild = 'NIGHTWRAITH'
  AND (power_updated_at IS NULL OR power_updated_at < '2026-08-12 02:20:00+00');

NOTIFY pgrst, 'reload schema';
