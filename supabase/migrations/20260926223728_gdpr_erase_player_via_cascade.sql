-- Corrects gm_erase_player from 20260927100000. The first version deleted the
-- roster row and then tried to anonymise the statistics -- which matched zero
-- rows, because seven tables declare
--   FOREIGN KEY (guild, pseudo) REFERENCES guild_members(guild, pseudo)
--       ON UPDATE CASCADE ON DELETE CASCADE
-- so the delete had already cascaded them away. Proved on the DEMO tenant.
-- Erasure is therefore an UPDATE: the rename propagates to all seven children
-- atomically and the statistics survive de-identified, as privacy.html §6.4 says.
CREATE OR REPLACE FUNCTION public.gm_erase_player(p_guild text, p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_pseudo     text;
    v_token      text;
    v_roster     integer := 0;
    v_absences   integer := 0;
    v_names      integer := 0;
    v_transfers  integer := 0;
    v_audit      integer := 0;
    v_cascaded   integer := 0;
BEGIN
    IF p_guild IS NULL OR btrim(p_guild) = '' OR p_uid IS NULL OR btrim(p_uid) = '' THEN
        RAISE EXCEPTION 'gm_erase_player: guild and uid are both required';
    END IF;

    IF NOT public.check_user_guild_write_access(p_guild) THEN
        RAISE EXCEPTION 'gm_erase_player: not authorised for guild %', p_guild
          USING ERRCODE = '42501';
    END IF;

    SELECT gm.pseudo INTO v_pseudo
      FROM public.guild_members gm
     WHERE gm.guild = p_guild AND gm.uid = p_uid
     LIMIT 1;

    IF v_pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
    END IF;

    SELECT (SELECT count(*) FROM public.event_participants     WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.event_daily_scores     WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.weekly_scores          WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.player_metrics_history WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.sanctions              WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.shadowfront_signups    WHERE guild = p_guild AND pseudo = v_pseudo)
         + (SELECT count(*) FROM public.shadowfront_squads     WHERE guild = p_guild AND pseudo = v_pseudo)
      INTO v_cascaded;

    v_token := 'erased_' || substr(encode(extensions.digest(v_pseudo || gen_random_uuid()::text, 'sha256'), 'hex'), 1, 12);

    UPDATE public.guild_members
       SET pseudo = v_token, uid = NULL, timezone = NULL, timezone_offset = NULL
     WHERE guild = p_guild AND uid = p_uid;
    GET DIAGNOSTICS v_roster = ROW_COUNT;

    DELETE FROM public.player_absences
     WHERE guild = p_guild AND (uid = p_uid OR pseudo = v_pseudo);
    GET DIAGNOSTICS v_absences = ROW_COUNT;

    DELETE FROM public.player_name_history WHERE guild = p_guild AND uid = p_uid;
    GET DIAGNOSTICS v_names = ROW_COUNT;

    DELETE FROM public.guild_transfers
     WHERE uid = p_uid AND (source_guild = p_guild OR target_guild = p_guild);
    GET DIAGNOSTICS v_transfers = ROW_COUNT;

    UPDATE public.system_audit_logs
       SET pseudo = v_token, uid = NULL
     WHERE guild = p_guild AND (uid = p_uid OR pseudo = v_pseudo);
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    INSERT INTO public.system_audit_logs (level, service, message, guild, metadata)
    VALUES ('INFO', 'gdpr', 'Player data erased under GDPR Art. 17', p_guild,
            jsonb_build_object('token', v_token, 'rows_carried_by_cascade', v_cascaded));

    RETURN jsonb_build_object(
        'ok', true,
        'token', v_token,
        'anonymised', jsonb_build_object(
            'guild_members', v_roster,
            'rows_carried_by_cascade', v_cascaded,
            'system_audit_logs', v_audit),
        'deleted', jsonb_build_object(
            'player_absences', v_absences,
            'player_name_history', v_names,
            'guild_transfers', v_transfers),
        'retained', jsonb_build_object(
            'banned_players', 'kept intact -- Art. 17(3), disclosed in privacy.html section 6.4')
    );
END;
$$;

COMMENT ON FUNCTION public.gm_erase_player(text, text) IS
'GDPR Art. 17 erasure for a player. Renames the roster row to a token from a discarded per-erasure salt, which ON UPDATE CASCADE propagates to the seven (guild, pseudo) child tables, so statistics survive de-identified. Deletes absences, pseudonym history and transfers. Ban records deliberately retained under Art. 17(3). Authorised by check_user_guild_write_access.';

REVOKE ALL ON FUNCTION public.gm_erase_player(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gm_erase_player(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.gm_erase_player(text, text) TO authenticated;
