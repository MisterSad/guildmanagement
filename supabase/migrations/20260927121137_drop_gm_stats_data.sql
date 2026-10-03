-- Phase S5: retire gm_stats_data.
--
-- It was the whole Stats data layer: four unbounded raw arrays -- members,
-- non-Glory participants, Glory participants, shadowfront squads -- with no
-- week filter and no aggregation, fetched four times per visit with no sharing.
-- About 10,000 rows per call for OMEGA, on a table growing ~3,000 rows a week,
-- with every count and distinct done in JavaScript afterwards.
--
-- Replaced by four aggregating RPCs, added one phase at a time so the page
-- never had zero working tabs: gm_stats_weeks (S1), gm_stats_members (S2,
-- reshaped in S3), gm_stats_health (S4) and gm_stats_events (S5).
--
-- It also carried `coalesce(v_user_guild, 'ALPHA')` TWICE -- ADR-003 invariant
-- #1, live in production: a super_admin whose guild did not resolve silently
-- read ALPHA. None of the four replacements has a tenant fallback; all four
-- delegate authorization to gm_can_read_guild_data, which additionally enforces
-- session validity (finding C1) and active status (finding M14), neither of
-- which this function checked.
--
-- Verified before dropping: zero `.rpc('gm_stats_data')` call sites in src/ or
-- supabase/functions/. 20260926140000 established that every RPC name in this
-- codebase is a string literal, so the grep is conclusive; and
-- tests/rpc_names_exist.test.js now enforces that permanently.

DROP FUNCTION IF EXISTS public.gm_stats_data(text);

DO $verify$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_stats_data'
    ) THEN
        RAISE EXCEPTION 'gm_stats_data survived the drop';
    END IF;

    -- The replacements must all be present before this is a safe state.
    IF (SELECT count(*) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('gm_stats_weeks', 'gm_stats_members', 'gm_stats_health', 'gm_stats_events')) <> 4 THEN
        RAISE EXCEPTION 'one of the four replacement RPCs is missing; do not drop gm_stats_data yet';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
