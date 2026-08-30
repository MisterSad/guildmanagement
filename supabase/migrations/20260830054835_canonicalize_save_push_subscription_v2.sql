-- Reconciliation: save_push_subscription() has been live since the archived
-- 2026-08-10 migrations but was never carried into the canonical migration
-- set (unlike the 13 functions ported in 20260823100000_canonical_reconciliation_round2.sql).
-- push.js:105 depends on it in production. This migration re-declares it
-- verbatim (CREATE OR REPLACE, idempotent) so a fresh environment built from
-- canonical migrations alone has it too.

CREATE OR REPLACE FUNCTION public.save_push_subscription(
    p_endpoint text,
    p_p256dh text,
    p_auth text,
    p_pseudo text DEFAULT NULL::text,
    p_ua text DEFAULT NULL::text
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

GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text, text) TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
