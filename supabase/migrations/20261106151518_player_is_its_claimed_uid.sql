-- A player is the in-game UID an account claimed, never the account's own id
-- (audit SEC2-01, BE-B-04).
--
-- Four RPCs let a caller act as the player `p_uid` when
--     a.uid = p_uid OR a.id = p_uid
-- held for the caller's account. The second half meant that an account whose
-- LOGIN ID equals a player's UID counted as that player, and a guild admin can
-- create an account with any id (admin-accounts `create`). The chain:
--   1. create a guild through Discord onboarding, on the victim's server;
--   2. create an account with id = the victim's in-game UID (visible in game);
--   3. sign in with it and request the victim's transfer into your guild
--      (request_guild_transfer), then approve it as the target guild: the
--      victim's roster row, history and member account move to you;
--   4. reset that member account's password and sign in as the victim.
-- The same half let anyone read any player's event history, metrics and KPIs.
--
-- member-portal no longer treats an account with no claimed UID as a player
-- (same change, `player_not_linked`), and admin-accounts refuses an all-digit
-- id. Here the database stops honouring the account id as a UID.
--
-- Measured on production before applying (2026-11-06): every one of the 104
-- member accounts has its UID set, none has uid = id, and no account's id
-- equals a roster UID -- so no legitimate caller depended on `a.id = p_uid`,
-- and the chain had not been used.
--
-- The four bodies are rewritten from their current definition with that one
-- clause replaced, so nothing else in them can drift; grants are kept by
-- CREATE OR REPLACE. Each is then checked.

DO $fix$
DECLARE
    v_fn   regprocedure;
    v_def  text;
    v_new  text;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        'public.request_guild_transfer(text, text)'::regprocedure,
        'public.gm_get_player_event_history(text, integer)'::regprocedure,
        'public.gm_get_player_metrics_history(text, integer)'::regprocedure,
        'public.gm_personal_kpis(text)'::regprocedure
    ] LOOP
        v_def := pg_get_functiondef(v_fn);
        v_new := replace(v_def, '(a.uid = p_uid OR a.id = p_uid)', 'a.uid = p_uid');
        IF v_new = v_def THEN
            RAISE EXCEPTION '% does not contain the account-id clause it should', v_fn;
        END IF;
        EXECUTE v_new;
    END LOOP;
END
$fix$;

DO $check$
DECLARE
    v_name text;
BEGIN
    SELECT p.proname INTO v_name
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND pg_get_functiondef(p.oid) ~ 'a\.id\s*=\s*p_uid'
     LIMIT 1;
    IF v_name IS NOT NULL THEN
        RAISE EXCEPTION '% still treats an account id as a player UID', v_name;
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.request_guild_transfer(text, text)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.gm_personal_kpis(text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.gm_personal_kpis(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the rewritten functions lost or gained a grant';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
