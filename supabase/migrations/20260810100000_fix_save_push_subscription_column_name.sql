-- 20260810100000_fix_save_push_subscription_column_name.sql
-- Fixes column name in save_push_subscription RPC:
-- push_subscriptions table uses last_seen column (not updated_at).

CREATE OR REPLACE FUNCTION public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_pseudo text DEFAULT NULL,
  p_ua text DEFAULT NULL
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

  INSERT INTO public.push_subscriptions (guild, endpoint, p256dh, auth, pseudo, ua, last_seen)
  VALUES (v_guild, p_endpoint, p_p256dh, p_auth, v_pseudo, p_ua, now())
  ON CONFLICT (endpoint) DO UPDATE
    SET guild = EXCLUDED.guild,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        pseudo = coalesce(EXCLUDED.pseudo, push_subscriptions.pseudo),
        ua = coalesce(EXCLUDED.ua, push_subscriptions.ua),
        last_seen = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_push_subscription(text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
