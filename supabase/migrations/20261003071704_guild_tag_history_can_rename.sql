-- gm_guild_tag_history also answers whether the caller may rename.
--
-- The "Guild TAG" card (src/modules/app/admin/guild-rename.ts) must be shown to
-- exactly the people gm_rename_guild accepts: a super_admin, or a guild_admin
-- of that guild. gm_guild_tag_history is gated on check_user_guild_write_access,
-- which also admits a server_admin of the guild's server -- who would then see a
-- button that always fails. Rather than repeat the rule in the client, the
-- server states it, with the same predicate gm_rename_guild uses.

CREATE OR REPLACE FUNCTION public.gm_guild_tag_history(p_guild text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_guild      text := nullif(btrim(p_guild), '');
    v_last       timestamptz;
    v_rows       jsonb;
    v_is_super   boolean;
    v_role       text;
BEGIN
    IF v_guild IS NULL OR NOT public.check_user_guild_write_access(v_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    v_is_super := public.is_super_admin();
    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
    LIMIT 1;

    SELECT max(h.changed_at) INTO v_last
    FROM public.guild_tag_history h WHERE h.guild = v_guild;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'old_tag', x.old_tag, 'new_tag', x.new_tag, 'changed_at', x.changed_at
           ) ORDER BY x.changed_at DESC), '[]'::jsonb)
      INTO v_rows
    FROM (
        SELECT h.old_tag, h.new_tag, h.changed_at
        FROM public.guild_tag_history h
        WHERE h.guild = v_guild
        ORDER BY h.changed_at DESC
        LIMIT 20
    ) x;

    RETURN jsonb_build_object(
        'ok', true,
        'history', v_rows,
        'next_allowed_at', CASE WHEN v_last IS NULL THEN NULL ELSE v_last + interval '7 days' END,
        -- Same predicate as gm_rename_guild's authorisation.
        'can_rename', v_is_super OR v_role = 'guild_admin',
        -- The cooldown does not apply to a super_admin.
        'cooldown_applies', NOT v_is_super
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_guild_tag_history(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_guild_tag_history(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
