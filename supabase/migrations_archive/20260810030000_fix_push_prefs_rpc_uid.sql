-- 20260810030000_fix_push_prefs_rpc_uid.sql
-- 1. Update push prefs RPCs to accept explicit p_uid parameter (resolving service role auth.uid() = NULL issue).
-- 2. Update save_push_subscription RPC to accept p_pseudo parameter.

-- 1. gm_get_push_prefs with p_uid parameter
DROP FUNCTION IF EXISTS public.gm_get_push_prefs();
DROP FUNCTION IF EXISTS public.gm_get_push_prefs(text);

CREATE OR REPLACE FUNCTION public.gm_get_push_prefs(p_uid text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid text;
  v_member record;
  v_prefs text[];
BEGIN
  IF p_uid IS NOT NULL AND p_uid <> '' THEN
    v_uid := p_uid;
  ELSE
    SELECT uid INTO v_uid
    FROM public.accounts
    WHERE auth_user_id = auth.uid();
  END IF;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('event_types', ARRAY['events', 'glory', 'challenges']);
  END IF;

  SELECT * INTO v_member
  FROM public.guild_members
  WHERE uid = v_uid
  LIMIT 1;

  IF v_member IS NULL THEN
    RETURN jsonb_build_object('event_types', ARRAY['events', 'glory', 'challenges']);
  END IF;

  SELECT event_types INTO v_prefs
  FROM public.player_push_prefs
  WHERE guild = v_member.guild AND lower(pseudo) = lower(v_member.pseudo);

  IF v_prefs IS NULL THEN
    v_prefs := ARRAY['events', 'glory', 'challenges'];
  END IF;

  RETURN jsonb_build_object('event_types', v_prefs);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_get_push_prefs(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_get_push_prefs(text) TO authenticated, service_role;

-- 2. gm_set_push_prefs with p_uid parameter
DROP FUNCTION IF EXISTS public.gm_set_push_prefs(text[]);
DROP FUNCTION IF EXISTS public.gm_set_push_prefs(text, text[]);

CREATE OR REPLACE FUNCTION public.gm_set_push_prefs(p_uid text, p_event_types text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid text;
  v_member record;
BEGIN
  IF p_uid IS NOT NULL AND p_uid <> '' THEN
    v_uid := p_uid;
  ELSE
    SELECT uid INTO v_uid
    FROM public.accounts
    WHERE auth_user_id = auth.uid();
  END IF;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
  END IF;

  SELECT * INTO v_member
  FROM public.guild_members
  WHERE uid = v_uid
  LIMIT 1;

  IF v_member IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
  END IF;

  INSERT INTO public.player_push_prefs (guild, pseudo, event_types, updated_at)
  VALUES (v_member.guild, v_member.pseudo, p_event_types, now())
  ON CONFLICT (guild, pseudo) DO UPDATE
    SET event_types = EXCLUDED.event_types,
        updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_set_push_prefs(text, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_set_push_prefs(text, text[]) TO authenticated, service_role;

-- 3. save_push_subscription with p_pseudo parameter
DROP FUNCTION IF EXISTS public.save_push_subscription(text, text, text);
DROP FUNCTION IF EXISTS public.save_push_subscription(text, text, text, text);

CREATE OR REPLACE FUNCTION public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_pseudo text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_guild text;
  v_pseudo text;
BEGIN
  SELECT guild INTO v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  v_guild := coalesce(v_guild, 'ALPHA');
  v_pseudo := p_pseudo;

  INSERT INTO public.push_subscriptions (guild, endpoint, p256dh, auth, pseudo, updated_at)
  VALUES (v_guild, p_endpoint, p_p256dh, p_auth, v_pseudo, now())
  ON CONFLICT (endpoint) DO UPDATE
    SET guild = EXCLUDED.guild,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        pseudo = coalesce(EXCLUDED.pseudo, push_subscriptions.pseudo),
        updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_push_subscription(text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text) TO authenticated;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
