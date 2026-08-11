-- 20260811191000_fix_nightwraith_tenant_and_server.sql
-- Fix guild ID to uppercase 'NIGHTWRAITH' and set server_number to '1078'

INSERT INTO public.guilds (id, subscription_type, server_number)
VALUES ('NIGHTWRAITH', 'Unlimited', '1078')
ON CONFLICT (id) DO UPDATE
  SET server_number = '1078';

-- Migrate members inserted under 'Nightwraith' to 'NIGHTWRAITH'
UPDATE public.guild_members
SET guild = 'NIGHTWRAITH'
WHERE guild = 'Nightwraith';

-- Delete legacy/mis-cased 'Nightwraith' entry from guilds
DELETE FROM public.guilds WHERE id = 'Nightwraith';

NOTIFY pgrst, 'reload schema';
