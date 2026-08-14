-- Add columns to public.guilds
ALTER TABLE public.guilds
  ADD COLUMN IF NOT EXISTS subscription_type text NOT NULL DEFAULT 'Unlimited' CHECK (subscription_type IN ('Unlimited', 'Premium')),
  ADD COLUMN IF NOT EXISTS subscription_end timestamptz;

-- Add check constraint ensuring Premium subscription has an end date
ALTER TABLE public.guilds DROP CONSTRAINT IF EXISTS check_subscription_end_premium;
ALTER TABLE public.guilds
  ADD CONSTRAINT check_subscription_end_premium
  CHECK (subscription_type = 'Unlimited' OR (subscription_type = 'Premium' AND subscription_end IS NOT NULL));

-- Define function to check if a guild's subscription is active
CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT
       CASE
         WHEN subscription_type = 'Unlimited' THEN true
         WHEN subscription_type = 'Premium' AND subscription_end >= now() THEN true
         ELSE false
       END
     FROM public.guilds
     WHERE id = p_guild),
    false
  );
$$;

-- Apply subscription active check to tenant data tables RLS policies
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'guild_members', 'event_participants', 'event_status',
    'shadowfront_squads', 'weekly_scores', 'sanctions', 'banned_players'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_all ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_select ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_insert ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_update ON public.%I;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS gm_authenticated_delete ON public.%I;', tbl);
    
    EXECUTE format('CREATE POLICY gm_authenticated_select ON public.%I FOR SELECT TO authenticated USING (true);', tbl);
    EXECUTE format('CREATE POLICY gm_authenticated_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_subscription_active(guild));', tbl);
    EXECUTE format('CREATE POLICY gm_authenticated_update ON public.%I FOR UPDATE TO authenticated USING (public.is_subscription_active(guild)) WITH CHECK (public.is_subscription_active(guild));', tbl);
    EXECUTE format('CREATE POLICY gm_authenticated_delete ON public.%I FOR DELETE TO authenticated USING (public.is_subscription_active(guild));', tbl);
  END LOOP;
END $$;

-- Update guild_config policy to block updates when subscription is expired (except for Super Admin/R5)
DROP POLICY IF EXISTS r4_manage_own ON public.guild_config;
CREATE POLICY r4_manage_own ON public.guild_config
  FOR ALL TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R4'
    AND guild = (SELECT accounts.guild FROM accounts WHERE accounts.auth_user_id = auth.uid())
    AND public.is_subscription_active(guild)
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'app_role') = 'R4'
    AND guild = (SELECT accounts.guild FROM accounts WHERE accounts.auth_user_id = auth.uid())
    AND public.is_subscription_active(guild)
  );
