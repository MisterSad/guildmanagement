-- ============================================================================
-- FGF GUILD MANAGEMENT — CANONICAL DEV SEEDS
-- File: supabase/seeds/dev_seed.sql
-- Description: Isolated seed script for development and staging environments.
-- ============================================================================

-- 1. Insert Standard Guilds
INSERT INTO public.guilds (id, name, server_number, subscription_type, created_at)
VALUES 
    ('ALPHA', 'Alpha Guild', '1001', 'Unlimited', now()),
    ('OMEGA', 'Omega Guild', '1001', 'Unlimited', now()),
    ('BABE', 'Babe Guild', '1001', 'Unlimited', now()),
    ('IMK', 'Imk Guild', '1001', 'Unlimited', now()),
    ('YARR', 'Yarr Guild', '1001', 'Unlimited', now()),
    ('CLAW', 'Claw Guild', '1001', 'Unlimited', now()),
    ('DEMO', 'Demo Guild', '1000', 'Unlimited', now()),
    ('SEN', 'Sen Guild', '1002', 'Unlimited', now()),
    ('NIGHTWRAITH', 'Nightwraith Guild', '1002', 'Unlimited', now()),
    ('OBSIDIANSTAR', 'Obsidian Star Guild', '1002', 'Unlimited', now()),
    ('ASTRAL_LIBERION', 'Astral Liberion', '1003', 'Unlimited', now()),
    ('BLACKTHUNDER', 'Black Thunder', '1003', 'Unlimited', now()),
    ('TWILIGHT', 'Twilight Guild', '1003', 'Unlimited', now())
ON CONFLICT (id) DO UPDATE SET
    subscription_type = EXCLUDED.subscription_type;

-- 2. Insert Super Admin & Demo Accounts
INSERT INTO public.accounts (id, role, guild, status, created_at)
VALUES 
    ('HawkEye', 'super_admin', 'ALPHA', 'active', now()),
    ('DemoAdmin', 'guild_admin', 'DEMO', 'active', now())
ON CONFLICT (id) DO NOTHING;

-- 3. Insert Demo Guild Members
INSERT INTO public.guild_members (uid, pseudo, guild, overall_power, role, created_at)
VALUES 
    ('10000001', 'CommanderAlpha', 'DEMO', 120000000, 'R5', now()),
    ('10000002', 'OfficerBravo', 'DEMO', 85000000, 'R4', now()),
    ('10000003', 'PilotCharlie', 'DEMO', 45000000, 'R3', now()),
    ('10000004', 'ScoutDelta', 'DEMO', 25000000, 'R2', now()),
    ('10000005', 'RecruitEcho', 'DEMO', 12000000, 'R1', now())
ON CONFLICT (guild, pseudo) DO NOTHING;

-- 4. Default Guild Config Settings
INSERT INTO public.guild_config (guild, key, value)
VALUES 
    ('DEMO', 'coeff_svs', '1.0'),
    ('DEMO', 'coeff_gvg', '1.0'),
    ('DEMO', 'coeff_shadowfront', '1.0'),
    ('DEMO', 'coeff_dtr', '1.0'),
    ('DEMO', 'coeff_armsrace', '1.0')
ON CONFLICT (guild, key) DO NOTHING;
