-- ═══════════════════════════════════════════════════════════════════════════
-- gm_admin_list: return the server number, resolved server-side
--
-- REPORTED SYMPTOM: on the Super Admin accounts screen every admin lands under
-- "Unassigned Server", listing all 26 guilds in one bucket, and the guild
-- dropdown of "Create Admin Account" is empty.
--
-- The data was never wrong: all 26 guilds carry a server_number and all 61
-- guild_admin rows carry a guild (only the super_admin's is NULL, by design,
-- which is why that one account correctly reads "All Guilds").
--
-- Two pre-existing causes compounded:
--
--   1. This function never returned `server_number`. The accounts screen reads
--      `acc.server_number` first, so it was `undefined` for every row.
--   2. Its fallback, `getServerNumberForGuild()`, reads `window.guildsData`,
--      which only `fetchGuilds()` fills -- and no loader for the accounts or
--      Super Admin tabs calls it. Reaching those tabs without having passed
--      through a code path that happened to fetch guilds left the map empty.
--
-- Returning the number here fixes it at the source, for every entry point at
-- once, instead of depending on some other fetch having run first.
--
-- It also repairs a filter that has been silently inert: `admin-accounts`
-- narrows the list for a `server_admin` with
-- `acc.server_number === info.serverNumber`, against a field this function did
-- not return -- so that half of the condition was always false and the filter
-- rested entirely on its guild-based branch.
--
-- `COALESCE(a.server_number, g.server_number)` is the same derivation
-- `validateCallerAuth` and `check_user_guild_access` already use: an account's
-- own number wins, otherwise its guild's. 43 of 61 guild_admin rows have no
-- number of their own, which is normal -- theirs comes from their guild.
--
-- The return type changes, so this is a DROP + CREATE rather than a REPLACE.
-- Checked first: no other function references gm_admin_list, and EXECUTE is
-- held only by service_role and postgres, which is restored below.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.gm_admin_list();

CREATE FUNCTION public.gm_admin_list()
RETURNS TABLE(
    id            text,
    role          text,
    guild         text,
    server_number text,
    auth_user_id  uuid,
    uid           text,
    status        text,
    created_at    timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  select a.id,
         coalesce(a.role, 'member'),
         a.guild,
         coalesce(a.server_number, g.server_number),
         a.auth_user_id,
         a.uid,
         coalesce(a.status, 'active'),
         a.created_at
  from public.accounts a
  left join public.guilds g on g.id = a.guild
  order by a.created_at desc;
$function$;

REVOKE ALL ON FUNCTION public.gm_admin_list() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_admin_list() TO service_role;

COMMENT ON FUNCTION public.gm_admin_list() IS
    'Admin account list for the admin-accounts Edge Function. Returns server_number resolved as COALESCE(accounts.server_number, guilds.server_number) so the UI never has to reconstruct it from a separately fetched guild map -- doing so is what grouped every admin under "Unassigned Server".';

DO $verify$
DECLARE
    v_unresolved int;
    v_cols       int;
BEGIN
    SELECT count(*) INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gm_admin_list' AND column_name = 'server_number';

    -- Every admin account that has a guild must now resolve to a server number.
    SELECT count(*) INTO v_unresolved
    FROM public.gm_admin_list() l
    WHERE l.guild IS NOT NULL AND (l.server_number IS NULL OR btrim(l.server_number) = '');
    IF v_unresolved <> 0 THEN
        RAISE EXCEPTION '% accounts still have a guild but no resolvable server number', v_unresolved;
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
