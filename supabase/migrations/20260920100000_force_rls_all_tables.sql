-- 20260920100000_force_rls_all_tables.sql
-- TICKET-01 [SEC-01]: Enforce FORCE ROW LEVEL SECURITY on all active public tables
-- Eliminates table-owner RLS bypass, guaranteeing strict multi-tenant isolation.

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'guilds',
        'accounts',
        'guild_members',
        'event_status',
        'event_participants',
        'shadowfront_squads',
        'shadowfront_signups',
        'weekly_scores',
        'sanctions',
        'banned_players',
        'guild_transfers',
        'guild_config',
        'player_absences',
        'player_push_prefs',
        'push_subscriptions',
        'player_name_history',
        'gm_payments',
        'system_audit_logs',
        'player_metrics_history',
        'diplomatic_treaties',
        'server_migration_groups',
        'server_migration_group_servers',
        'webauthn_challenges',
        'account_passkeys',
        'account_backup_codes',
        'discord_verification_throttle'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = t
        ) THEN
            EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
        END IF;
    END LOOP;
END $$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
