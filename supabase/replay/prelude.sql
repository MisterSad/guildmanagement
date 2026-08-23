-- supabase/replay/prelude.sql
-- REPLAY-ONLY SHIM: Never applied to live database.
-- Used to provide Supabase system schemas/functions when replaying migrations on clean PostgreSQL 17.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS cron;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb; $$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid; $$;

CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text UNIQUE NOT NULL,
    decrypted_secret text NOT NULL
);

CREATE TABLE IF NOT EXISTS vault.secrets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text UNIQUE NOT NULL,
    secret text NOT NULL
);

CREATE OR REPLACE FUNCTION vault.create_secret(secret text, name text, description text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
    INSERT INTO vault.secrets (id, name, secret) VALUES (v_id, name, secret)
    ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;
    INSERT INTO vault.decrypted_secrets (id, name, decrypted_secret) VALUES (v_id, name, secret)
    ON CONFLICT (name) DO UPDATE SET decrypted_secret = EXCLUDED.decrypted_secret;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint; $$;

CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint; $$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;

CREATE TABLE IF NOT EXISTS cron.job (
    jobid bigint PRIMARY KEY,
    schedule text,
    command text,
    jobname text
);
