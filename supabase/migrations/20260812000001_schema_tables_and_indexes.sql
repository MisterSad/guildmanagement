-- ============================================================================
-- FGF GUILD MANAGEMENT — CANONICAL DDL SCHEMA (Migration 1 of 4)
-- Migration: 20260812000001_schema_tables_and_indexes.sql
-- Description: Consolidated tables, primary keys, foreign keys, and indexes.
-- ============================================================================

-- 1. GUILDS
CREATE TABLE IF NOT EXISTS public.guilds (
    id TEXT PRIMARY KEY,
    name TEXT,
    server_number TEXT,
    subscription_type TEXT NOT NULL DEFAULT 'Unlimited',
    subscription_end TIMESTAMPTZ,
    payments_disabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. ACCOUNTS
CREATE TABLE IF NOT EXISTS public.accounts (
    id TEXT PRIMARY KEY,
    role TEXT DEFAULT 'R4',
    guild TEXT REFERENCES public.guilds(id) ON DELETE SET NULL,
    uid TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    auth_user_id UUID,
    password_enc BYTEA,
    gotrue_secret_enc BYTEA,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. GUILD MEMBERS
CREATE TABLE IF NOT EXISTS public.guild_members (
    id BIGSERIAL PRIMARY KEY,
    uid TEXT,
    pseudo TEXT NOT NULL,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    overall_power BIGINT DEFAULT 0,
    role TEXT DEFAULT 'R1',
    timezone_offset INTEGER,
    power_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT guild_members_guild_pseudo_key UNIQUE (guild, pseudo)
);

-- 4. EVENT STATUS
CREATE TABLE IF NOT EXISTS public.event_status (
    id BIGSERIAL PRIMARY KEY,
    event_name TEXT NOT NULL,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    session_id TEXT,
    is_active BOOLEAN NOT NULL DEFAULT false,
    stage TEXT,
    start_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_status_guild_event_name_session_key UNIQUE (guild, event_name, session_id)
);

-- 5. EVENT PARTICIPANTS
CREATE TABLE IF NOT EXISTS public.event_participants (
    id BIGSERIAL PRIMARY KEY,
    event_name TEXT NOT NULL,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    pseudo TEXT NOT NULL,
    session_id TEXT,
    week_start DATE NOT NULL,
    participated INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    score_prep INTEGER,
    score_pvp INTEGER,
    late BOOLEAN DEFAULT false,
    excused BOOLEAN DEFAULT false,
    appointed BOOLEAN DEFAULT false,
    sub_present BOOLEAN DEFAULT false,
    is_pending BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fk_event_participants_member FOREIGN KEY (guild, pseudo) 
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT event_participants_guild_event_session_pseudo_key UNIQUE (guild, event_name, session_id, pseudo)
);

-- 6. SHADOWFRONT SQUADS
CREATE TABLE IF NOT EXISTS public.shadowfront_squads (
    id BIGSERIAL PRIMARY KEY,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    pseudo TEXT NOT NULL,
    squad TEXT NOT NULL,
    role TEXT NOT NULL,
    session_id TEXT,
    is_commander BOOLEAN DEFAULT false,
    CONSTRAINT fk_shadowfront_squads_member FOREIGN KEY (guild, pseudo) 
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT shadowfront_squads_guild_week_pseudo_key UNIQUE (guild, week_start, pseudo)
);

-- 7. SHADOWFRONT SIGNUPS
CREATE TABLE IF NOT EXISTS public.shadowfront_signups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    pseudo TEXT NOT NULL,
    availability TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fk_shadowfront_signups_member FOREIGN KEY (guild, pseudo) 
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT shadowfront_signups_guild_week_pseudo_key UNIQUE (guild, week_start, pseudo)
);

-- 8. WEEKLY SCORES
CREATE TABLE IF NOT EXISTS public.weekly_scores (
    id BIGSERIAL PRIMARY KEY,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    pseudo TEXT NOT NULL,
    score_20 NUMERIC NOT NULL DEFAULT 0,
    events_done INTEGER DEFAULT 0,
    events_total INTEGER DEFAULT 0,
    glory_score INTEGER DEFAULT 0,
    computed_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fk_weekly_scores_member FOREIGN KEY (guild, pseudo) 
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT weekly_scores_guild_week_pseudo_key UNIQUE (guild, week_start, pseudo)
);

-- 9. SANCTIONS
CREATE TABLE IF NOT EXISTS public.sanctions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    pseudo TEXT NOT NULL,
    comment TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fk_sanctions_member FOREIGN KEY (guild, pseudo) 
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 10. BANNED PLAYERS
CREATE TABLE IF NOT EXISTS public.banned_players (
    id BIGSERIAL PRIMARY KEY,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    pseudo TEXT,
    reason TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT banned_players_guild_uid_key UNIQUE (guild, uid)
);

-- 11. GUILD TRANSFERS
CREATE TABLE IF NOT EXISTS public.guild_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid TEXT NOT NULL,
    pseudo TEXT NOT NULL,
    source_guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    target_guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_by UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 12. GUILD CONFIG
CREATE TABLE IF NOT EXISTS public.guild_config (
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    PRIMARY KEY (guild, key)
);

-- 13. PLAYER ABSENCES
CREATE TABLE IF NOT EXISTS public.player_absences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    pseudo TEXT NOT NULL,
    uid TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'full',
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14. PLAYER PUSH PREFS
CREATE TABLE IF NOT EXISTS public.player_push_prefs (
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    pseudo TEXT NOT NULL,
    event_types TEXT[] NOT NULL DEFAULT ARRAY['events'::text, 'glory'::text, 'challenges'::text],
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild, pseudo)
);

-- 15. PUSH SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    pseudo TEXT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    ua TEXT,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16. EVENT REMINDERS SENT
CREATE TABLE IF NOT EXISTS public.event_reminders_sent (
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    offset_min INTEGER NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild, event_name, start_at, offset_min)
);

-- 17. DISCORD NOTIFICATIONS SENT
CREATE TABLE IF NOT EXISTS public.discord_notifications_sent (
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    reminder_type TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild, event_id, reminder_type)
);

-- 18. PLAYER NAME HISTORY
CREATE TABLE IF NOT EXISTS public.player_name_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    old_pseudo TEXT NOT NULL,
    new_pseudo TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at TIMESTAMPTZ DEFAULT now()
);

-- 19. GM PAYMENTS
CREATE TABLE IF NOT EXISTS public.gm_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'stripe',
    order_id TEXT,
    token TEXT,
    merchant_order_ext_ref TEXT,
    plan_key TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    days_added INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 20. SYSTEM AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.system_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level TEXT NOT NULL,
    service TEXT NOT NULL,
    correlation_id TEXT,
    guild TEXT,
    user_identifier TEXT,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    error_details JSONB,
    duration_ms NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- PERFORMANCE & TENANT COVERING INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_accounts_auth_user_id ON public.accounts(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_guild ON public.accounts(guild);
CREATE INDEX IF NOT EXISTS idx_guild_members_uid ON public.guild_members(uid);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON public.guild_members(guild);

CREATE INDEX IF NOT EXISTS idx_event_participants_guild_pseudo ON public.event_participants(guild, pseudo);
CREATE INDEX IF NOT EXISTS idx_event_participants_session ON public.event_participants(guild, session_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_week ON public.event_participants(guild, week_start);

CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_guild_pseudo ON public.shadowfront_squads(guild, pseudo);
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_week ON public.shadowfront_squads(guild, week_start);
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_pseudo_guild ON public.shadowfront_signups(pseudo, guild);

CREATE INDEX IF NOT EXISTS idx_sanctions_guild_pseudo ON public.sanctions(guild, pseudo);
CREATE INDEX IF NOT EXISTS idx_guild_transfers_fkeys ON public.guild_transfers(source_guild, target_guild, resolved_by);
CREATE INDEX IF NOT EXISTS idx_player_absences_guild_uid ON public.player_absences(guild, uid);

CREATE INDEX IF NOT EXISTS idx_system_audit_logs_guild_created ON public.system_audit_logs(guild, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_audit_logs_level_created ON public.system_audit_logs(level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_audit_logs_correlation ON public.system_audit_logs(correlation_id);
