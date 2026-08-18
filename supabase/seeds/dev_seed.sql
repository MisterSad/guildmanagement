-- ============================================================================
-- FGF GUILD MANAGEMENT — CANONICAL DEV SEEDS
-- File: supabase/seeds/dev_seed.sql
-- Description: Isolated seed script for development and staging environments.
-- ============================================================================

-- 1. Insert Standard Guilds
INSERT INTO public.guilds (id, server_number, subscription_type, payments_disabled, created_at)
VALUES 
    ('ALPHA', '1001', 'Unlimited', false, now()),
    ('OMEGA', '1001', 'Unlimited', false, now()),
    ('BABE', '1001', 'Unlimited', false, now()),
    ('IMK', '1001', 'Unlimited', false, now()),
    ('YARR', '1001', 'Unlimited', false, now()),
    ('CLAW', '1001', 'Unlimited', false, now()),
    ('DEMO', '0000', 'Unlimited', true, now()),
    ('SEN', '1002', 'Unlimited', false, now()),
    ('NIGHTWRAITH', '1002', 'Unlimited', false, now()),
    ('OBSIDIANSTAR', '1002', 'Unlimited', false, now()),
    ('ASTRAL_LIBERION', '1003', 'Unlimited', false, now()),
    ('BLACKTHUNDER', '1003', 'Unlimited', false, now()),
    ('TWILIGHT', '1003', 'Unlimited', false, now())
ON CONFLICT (id) DO UPDATE SET
    subscription_type = EXCLUDED.subscription_type,
    payments_disabled = EXCLUDED.payments_disabled;

-- 2. Insert Super Admin Account
INSERT INTO public.accounts (id, role, guild, status, created_at)
VALUES 
    ('HawkEye', 'super_admin', 'ALPHA', 'active', now())
ON CONFLICT (id) DO NOTHING;

-- 3. Reset and Populate DEMO Tenant with Dynamic Fictional Dataset & Metrics
SELECT public.gm_reset_demo_tenant_data();
