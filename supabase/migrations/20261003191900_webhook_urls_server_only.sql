-- ARC-04, remainder (medium-term plan, M2): the browser no longer reads or
-- writes Discord webhook URLs.
--
-- Since the short-term plan nothing posts to Discord from the browser -- the
-- discord-webhook-proxy Edge Function resolves the URL from guild_config with
-- the service key. But the admin screens still SELECTed every webhook URL to
-- know whether one existed, held them in the page, and mirrored them into
-- localStorage. A webhook URL is a bearer credential for a Discord channel:
-- anything that can read the page could post as the guild.
--
-- After this migration:
--   * `authenticated` sees no webhook row of guild_config, and cannot insert,
--     update or delete one. Writes go through discord-webhook-proxy's
--     `set-webhook` action, which accepts Discord webhook URLs only.
--   * gm_configured_webhooks(guild) answers WHICH webhook keys are set, never
--     their values, to the same callers that may read the guild's config.
--
-- Measured on production before writing this: 9 webhook keys in use
-- (discord_webhook_url and webhook_*), 75 non-empty values, all 75 valid
-- Discord webhook URLs -- so the server-side validation rejects none of the
-- existing data.

-- The one definition of "a webhook key". IMMUTABLE so the policies inline it.
CREATE OR REPLACE FUNCTION public.gm_is_webhook_key(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_key = 'discord_webhook_url' OR p_key LIKE 'webhook\_%';
$function$;

REVOKE ALL ON FUNCTION public.gm_is_webhook_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_is_webhook_key(text) TO authenticated, service_role;

DROP POLICY IF EXISTS gm_authenticated_select ON public.guild_config;
CREATE POLICY gm_authenticated_select ON public.guild_config
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild) AND NOT public.gm_is_webhook_key(key));

DROP POLICY IF EXISTS gm_guild_config_insert ON public.guild_config;
CREATE POLICY gm_guild_config_insert ON public.guild_config
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild) AND NOT public.gm_is_webhook_key(key));

DROP POLICY IF EXISTS gm_guild_config_update ON public.guild_config;
CREATE POLICY gm_guild_config_update ON public.guild_config
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild) AND NOT public.gm_is_webhook_key(key))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild) AND NOT public.gm_is_webhook_key(key));

DROP POLICY IF EXISTS gm_guild_config_delete ON public.guild_config;
CREATE POLICY gm_guild_config_delete ON public.guild_config
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild) AND NOT public.gm_is_webhook_key(key));

-- Which webhook keys of a guild hold a value. Never the value.
CREATE OR REPLACE FUNCTION public.gm_configured_webhooks(p_guild text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    -- Same audience as the guild's config rows (includes the session check).
    IF NOT public.gm_can_read_guild_data(p_guild) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE((
        SELECT array_agg(c.key ORDER BY c.key)
        FROM public.guild_config c
        WHERE c.guild = p_guild
          AND public.gm_is_webhook_key(c.key)
          AND btrim(COALESCE(c.value, '')) <> ''
    ), ARRAY[]::text[]);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_configured_webhooks(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_configured_webhooks(text) TO authenticated, service_role;

-- End state: no policy of guild_config lets `authenticated` touch a webhook row.
DO $check$
DECLARE v_bad int;
BEGIN
    SELECT count(*) INTO v_bad
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'guild_config'
      AND 'authenticated' = ANY (roles)
      AND NOT (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%gm_is_webhook_key(key)%';
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'a guild_config policy still exposes webhook URLs (% policies)', v_bad;
    END IF;
END;
$check$;

NOTIFY pgrst, 'reload schema';
