-- ARC-04: webhook URLs never reach a browser session. The guild's admins learn
-- WHICH webhooks are set, never their values, and cannot write one directly.
BEGIN;
SELECT tests.fixture();

INSERT INTO public.guild_config (guild, key, value) VALUES
  ('TA', 'webhook_gvg', 'https://discord.com/api/webhooks/1/secret-gvg'),
  ('TA', 'discord_webhook_url', 'https://discord.com/api/webhooks/2/secret-default'),
  ('TA', 'webhook_svs', '   '),
  ('TA', 'coeff_svs', '1.5'),
  ('TB', 'webhook_gvg', 'https://discord.com/api/webhooks/3/secret-tb');

SELECT tests.login('t_admin_a');
SELECT tests.assert_eq((SELECT count(*) FROM public.guild_config WHERE guild = 'TA' AND public.gm_is_webhook_key(key))::int, 0,
                       'a guild admin reads no webhook row of its own guild');
SELECT tests.assert_eq((SELECT value FROM public.guild_config WHERE guild = 'TA' AND key = 'coeff_svs'), '1.5'::text,
                       'the other config keys stay readable');
SELECT tests.assert_eq(public.gm_configured_webhooks('TA'), ARRAY['discord_webhook_url', 'webhook_gvg']::text[],
                       'the RPC names the set keys, and a blank value is not set');
SELECT tests.assert_raises($q$SELECT public.gm_configured_webhooks('TB')$q$,
                           'another guild''s webhooks are not even named', '42501');
SELECT tests.assert_raises($q$INSERT INTO public.guild_config (guild, key, value) VALUES ('TA', 'webhook_dtr', 'https://evil.example/x')$q$,
                           'a browser cannot insert a webhook', '42501');
SELECT tests.assert_eq(tests.rows($q$UPDATE public.guild_config SET value = 'https://evil.example/x' WHERE guild = 'TA' AND key = 'webhook_gvg'$q$), 0,
                       'a browser cannot repoint a webhook');
SELECT tests.assert_eq(tests.rows($q$DELETE FROM public.guild_config WHERE guild = 'TA' AND key = 'webhook_gvg'$q$), 0,
                       'a browser cannot delete a webhook');
SELECT tests.assert_eq(tests.rows($q$UPDATE public.guild_config SET value = '2' WHERE guild = 'TA' AND key = 'coeff_svs'$q$), 1,
                       'the other config keys stay writable');

SELECT tests.login('t_server');
SELECT tests.assert_eq(public.gm_configured_webhooks('TB'), ARRAY['webhook_gvg']::text[],
                       'a server admin sees which webhooks a guild of its server has');
SELECT tests.assert_raises($q$SELECT public.gm_configured_webhooks('TC')$q$,
                           'but not those of another server', '42501');

SELECT tests.login('t_member_a');
SELECT tests.assert_raises($q$SELECT public.gm_configured_webhooks('TA')$q$,
                           'a member is not told', '42501');

SELECT tests.anon();
SELECT tests.assert_raises($q$SELECT public.gm_configured_webhooks('TA')$q$,
                           'anon cannot call it', '42501');

SELECT tests.login_stale('t_admin_a');
SELECT tests.assert_raises($q$SELECT public.gm_configured_webhooks('TA')$q$,
                           'a revoked session is refused', '42501');
SELECT tests.logout();
SELECT tests.assert_eq((SELECT value FROM public.guild_config WHERE guild = 'TA' AND key = 'webhook_gvg'),
                       'https://discord.com/api/webhooks/1/secret-gvg'::text, 'the stored URL is untouched');
ROLLBACK;
