-- supabase/seeds/dev_seed.sql
-- Seed script for local development and staging environments.
-- Separated from DDL migrations to keep schema migration history clean.

-- Insert Demo Guild
INSERT INTO public.guilds (guild, name, server_number, created_at)
VALUES ('DEMO', 'Demo Guild', 1000, NOW())
ON CONFLICT (guild) DO NOTHING;

-- Insert Demo Admin Account (password encrypted in production via edge functions)
INSERT INTO public.accounts (identifier, role, guild, status, created_at)
VALUES ('DemoAdmin', 'guild_admin', 'DEMO', 'active', NOW())
ON CONFLICT (identifier) DO NOTHING;

-- Insert Demo Guild Members
INSERT INTO public.guild_members (uid, pseudo, guild, overall_power, created_at)
VALUES 
  ('10000001', 'CommanderAlpha', 'DEMO', 120000000, NOW()),
  ('10000002', 'OfficerBravo', 'DEMO', 85000000, NOW()),
  ('10000003', 'PilotCharlie', 'DEMO', 45000000, NOW())
ON CONFLICT (uid) DO NOTHING;
