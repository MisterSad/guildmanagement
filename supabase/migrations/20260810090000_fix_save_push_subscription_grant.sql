-- 20260810090000_fix_save_push_subscription_grant.sql
-- Grant EXECUTE on save_push_subscription to both anon and authenticated
-- so device push subscriptions work for anonymous PWA devices and authenticated users alike.

GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
