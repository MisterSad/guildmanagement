-- 20260819203500_drop_orphaned_notification_tables.sql
-- Drop legacy orphaned notification tracking tables (discord_notifications_sent and event_reminders_sent)
-- and update public.gm_reset_demo_tenant_data() to remove references to these tables.

-- 1. Drop orphaned tables and any dependent policies
DROP TABLE IF EXISTS public.discord_notifications_sent CASCADE;
DROP TABLE IF EXISTS public.event_reminders_sent CASCADE;

-- 2. Redefine public.gm_reset_demo_tenant_data() without references to dropped tables
CREATE OR REPLACE FUNCTION public.gm_reset_demo_tenant_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_today date := CURRENT_DATE;
    v_cur_week date := (date_trunc('week', CURRENT_DATE)::date);
    v_weeks date[] := ARRAY[
        (v_cur_week - 28),
        (v_cur_week - 21),
        (v_cur_week - 14),
        (v_cur_week - 7),
        v_cur_week
    ];
    v_w date;
    v_idx int;
    v_members_count int := 0;
    v_m record;
    v_pseudo text;
    v_uid text;
    v_power bigint;
    v_tech bigint;
    v_champ bigint;
    v_crew bigint;
    v_flag bigint;
    v_fleet bigint;
    v_glory bigint;
    v_role text;
    v_tz int;
    v_sid text;
    v_part int;
    v_score int;
    v_score_prep int;
    v_score_pvp int;
    v_late boolean;
    v_excused boolean;
    v_events_done int;
    v_score_20 numeric;
    v_drift numeric;
BEGIN
    -- Step 1: Cleanly purge existing DEMO tenant records in foreign-key dependency order
    DELETE FROM public.player_metrics_history WHERE guild = 'DEMO';
    DELETE FROM public.shadowfront_signups WHERE guild = 'DEMO';
    DELETE FROM public.shadowfront_squads WHERE guild = 'DEMO';
    DELETE FROM public.weekly_scores WHERE guild = 'DEMO';
    DELETE FROM public.sanctions WHERE guild = 'DEMO';
    DELETE FROM public.banned_players WHERE guild = 'DEMO';
    DELETE FROM public.player_absences WHERE guild = 'DEMO';
    DELETE FROM public.player_name_history WHERE guild = 'DEMO';
    DELETE FROM public.player_push_prefs WHERE guild = 'DEMO';
    DELETE FROM public.push_subscriptions WHERE guild = 'DEMO';
    DELETE FROM public.event_participants WHERE guild = 'DEMO';
    DELETE FROM public.event_status WHERE guild = 'DEMO';
    DELETE FROM public.guild_members WHERE guild = 'DEMO';
    DELETE FROM public.guild_config WHERE guild = 'DEMO';

    -- Step 2: Ensure DEMO guild entry exists with unlimited subscription and disabled payments
    INSERT INTO public.guilds (id, server_number, subscription_type, subscription_end, payments_disabled, created_at)
    VALUES ('DEMO', '0000', 'Unlimited', NULL, true, now())
    ON CONFLICT (id) DO UPDATE SET
        server_number = EXCLUDED.server_number,
        subscription_type = EXCLUDED.subscription_type,
        payments_disabled = true;

    -- Step 3: Ensure demo accounts are active, properly scoped, and initialized with demo passwords
    INSERT INTO public.accounts (id, role, guild, server_number, status, uid, password_enc, created_at)
    VALUES 
        (
            'DemoAdmin',
            'guild_admin',
            'DEMO',
            '0000',
            'active',
            NULL,
            extensions.pgp_sym_encrypt('demo1234', (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
            now()
        ),
        (
            'DemoPlayer',
            'member',
            'DEMO',
            '0000',
            'active',
            '90000002',
            extensions.pgp_sym_encrypt('demo1234', (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
            now()
        )
    ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        guild = EXCLUDED.guild,
        server_number = EXCLUDED.server_number,
        status = 'active',
        uid = EXCLUDED.uid,
        password_enc = EXCLUDED.password_enc;

    -- Step 4: Seed 60 rich, realistic DEMO guild members with 7 military metrics
    CREATE TEMP TABLE tmp_demo_roster (
        idx serial,
        pseudo text,
        uid text,
        role text,
        power bigint,
        tech bigint,
        champ bigint,
        crew bigint,
        flag bigint,
        fleet bigint,
        glory bigint,
        tz int
    ) ON COMMIT DROP;

    INSERT INTO tmp_demo_roster (pseudo, uid, role, power, tech, champ, crew, flag, fleet, glory, tz) VALUES
        ('Ares_Actual', '90000001', 'R5', 185000000, 32500000, 52000000, 18500000, 24500000, 4850000, 485000000, 1),
        ('Valkyrie', '90000002', 'R4', 162000000, 29000000, 48000000, 16000000, 21000000, 4400000, 420000000, 2),
        ('Titan_Prime', '90000003', 'R4', 154000000, 27500000, 45000000, 15500000, 19500000, 4150000, 395000000, 0),
        ('ShadowRaven', '90000004', 'R4', 148000000, 26000000, 43500000, 14800000, 18800000, 3950000, 370000000, -5),
        ('IronClaw', '90000005', 'R4', 142000000, 25000000, 41000000, 14200000, 18200000, 3800000, 350000000, 1),
        ('NovaStrike', '90000006', 'R4', 135000000, 24000000, 39500000, 13500000, 17500000, 3650000, 330000000, 3),
        ('GhostStalker', '90000007', 'R3', 128000000, 22500000, 37000000, 12800000, 16500000, 3450000, 310000000, 0),
        ('ApexPredator', '90000008', 'R3', 122000000, 21500000, 35500000, 12200000, 15800000, 3300000, 295000000, 2),
        ('Dreadnought', '90000009', 'R3', 118000000, 20500000, 34000000, 11800000, 15200000, 3200000, 280000000, -4),
        ('Solaris', '90000010', 'R3', 112000000, 19800000, 32500000, 11200000, 14500000, 3050000, 265000000, 1),
        ('VortexBlade', '90000011', 'R3', 108000000, 19000000, 31000000, 10800000, 14000000, 2950000, 250000000, 0),
        ('Hyperion', '90000012', 'R3', 104000000, 18200000, 30000000, 10400000, 13500000, 2850000, 240000000, -8),
        ('CyberWolf', '90000013', 'R3', 99000000, 17500000, 28500000, 9900000, 12800000, 2700000, 225000000, 1),
        ('Oblivion', '90000014', 'R3', 95000000, 16800000, 27500000, 9500000, 12200000, 2600000, 215000000, 2),
        ('Zephyr', '90000015', 'R3', 92000000, 16200000, 26500000, 9200000, 11800000, 2500000, 205000000, 0),
        ('Nemesis_X', '90000016', 'R3', 88000000, 15500000, 25000000, 8800000, 11200000, 2400000, 195000000, 1),
        ('Chronos', '90000017', 'R3', 85000000, 15000000, 24200000, 8500000, 10800000, 2300000, 185000000, -5),
        ('StormBringer', '90000018', 'R3', 82000000, 14500000, 23500000, 8200000, 10400000, 2200000, 175000000, 2),
        ('RaptorFleet', '90000019', 'R3', 79000000, 13800000, 22500000, 7900000, 10000000, 2120000, 165000000, 0),
        ('AbyssalLord', '90000020', 'R3', 76000000, 13200000, 21800000, 7600000, 9600000, 2050000, 158000000, 1),
        ('PhantomAce', '90000021', 'R2', 73000000, 12800000, 20800000, 7300000, 9200000, 1980000, 150000000, 3),
        ('DarkMatter', '90000022', 'R2', 70000000, 12200000, 20000000, 7000000, 8800000, 1900000, 142000000, 0),
        ('Leviathan', '90000023', 'R2', 68000000, 11800000, 19400000, 6800000, 8500000, 1840000, 135000000, -6),
        ('StarCrusher', '90000024', 'R2', 65000000, 11200000, 18500000, 6500000, 8100000, 1760000, 128000000, 1),
        ('KrakenVessel', '90000025', 'R2', 63000000, 10900000, 17900000, 6300000, 7800000, 1700000, 122000000, 2),
        ('Thunderbolt', '90000026', 'R2', 61000000, 10500000, 17300000, 6100000, 7500000, 1640000, 116000000, 0),
        ('OmegaVanguard', '90000027', 'R2', 59000000, 10100000, 16700000, 5900000, 7300000, 1580000, 110000000, 1),
        ('EclipseCore', '90000028', 'R2', 57000000, 9800000, 16200000, 5700000, 7000000, 1520000, 105000000, -7),
        ('Sentinel_01', '90000029', 'R2', 55000000, 9400000, 15600000, 5500000, 6800000, 1460000, 100000000, 2),
        ('AegisGuard', '90000030', 'R2', 53000000, 9000000, 15000000, 5300000, 6500000, 1400000, 95000000, 0),
        ('NightHawk', '90000031', 'R2', 51000000, 8700000, 14400000, 5100000, 6200000, 1350000, 90000000, 1),
        ('InfernoRay', '90000032', 'R2', 49000000, 8300000, 13800000, 4900000, 6000000, 1300000, 85000000, 4),
        ('CosmicDrift', '90000033', 'R2', 47000000, 8000000, 13200000, 4700000, 5700000, 1250000, 80000000, 0),
        ('PolarisWing', '90000034', 'R2', 45000000, 7600000, 12700000, 4500000, 5500000, 1200000, 75000000, -5),
        ('WarHammer', '90000035', 'R2', 43000000, 7300000, 12100000, 4300000, 5200000, 1140000, 70000000, 1),
        ('BloodHound', '90000036', 'R2', 41000000, 6900000, 11500000, 4100000, 5000000, 1080000, 66000000, 2),
        ('Starlight', '90000037', 'R2', 39000000, 6600000, 10900000, 3900000, 4700000, 1030000, 62000000, 0),
        ('GlacierEdge', '90000038', 'R2', 37000000, 6200000, 10400000, 3700000, 4500000, 980000, 58000000, 1),
        ('VenomFang', '90000039', 'R2', 35000000, 5900000, 9800000, 3500000, 4200000, 920000, 54000000, -4),
        ('AlphaCorsair', '90000040', 'R2', 33000000, 5500000, 9200000, 3300000, 4000000, 870000, 50000000, 2),
        ('StarGazer', '90000041', 'R1', 31000000, 5200000, 8700000, 3100000, 3700000, 820000, 46000000, 0),
        ('SkyBreaker', '90000042', 'R1', 29000000, 4800000, 8100000, 2900000, 3500000, 760000, 42000000, 1),
        ('CyberGhost', '90000043', 'R1', 27000000, 4500000, 7500000, 2700000, 3200000, 710000, 38000000, 3),
        ('FalconStrike', '90000044', 'R1', 25000000, 4200000, 7000000, 2500000, 3000000, 660000, 34000000, 0),
        ('OnyxReaper', '90000045', 'R1', 23000000, 3800000, 6400000, 2300000, 2700000, 600000, 30000000, -6),
        ('SolarFlare', '90000046', 'R1', 21000000, 3500000, 5800000, 2100000, 2500000, 550000, 26000000, 1),
        ('TitanGuard', '90000047', 'R1', 19000000, 3100000, 5300000, 1900000, 2200000, 500000, 22000000, 2),
        ('AstroKnight', '90000048', 'R1', 17000000, 2800000, 4700000, 1700000, 2000000, 440000, 19000000, 0),
        ('MeteorRain', '90000049', 'R1', 15000000, 2400000, 4100000, 1500000, 1700000, 390000, 16000000, 1),
        ('VoidEcho', '90000050', 'R1', 13000000, 2100000, 3600000, 1300000, 1500000, 340000, 13000000, -5),
        ('RogueSpecter', '90000051', 'R1', 11000000, 1800000, 3000000, 1100000, 1200000, 280000, 10000000, 2),
        ('QuasarPulse', '90000052', 'R1', 9500000, 1500000, 2600000, 950000, 1100000, 240000, 8000000, 0),
        ('DriftRunner', '90000053', 'R1', 8000000, 1200000, 2200000, 800000, 900000, 200000, 6500000, 1),
        ('CometTail', '90000054', 'R1', 6800000, 1000000, 1800000, 680000, 750000, 170000, 5000000, 0),
        ('NovaCadet', '90000055', 'R1', 5500000, 800000, 1500000, 550000, 600000, 130000, 4000000, -3),
        ('StarRecruit', '90000056', 'R1', 4500000, 650000, 1200000, 450000, 500000, 110000, 3000000, 1),
        ('CosmoPilot', '90000057', 'R1', 3500000, 500000, 900000, 350000, 380000, 85000, 2200000, 2),
        ('FleetCadet_A', '90000058', 'R1', 2500000, 350000, 650000, 250000, 270000, 60000, 1500000, 0),
        ('FleetCadet_B', '90000059', 'R1', 1800000, 250000, 450000, 180000, 190000, 42000, 1000000, 1),
        ('FleetCadet_C', '90000060', 'R1', 1200000, 160000, 300000, 120000, 130000, 28000, 600000, 0);

    -- Insert into guild_members
    INSERT INTO public.guild_members (
        pseudo, guild, role, overall_power, tech_power, champion_power,
        crew_power, flagship_power, fleet_rating, glory_score,
        timezone_offset, uid, created_at
    )
    SELECT
        r.pseudo, 'DEMO', r.role, r.power, r.tech, r.champ,
        r.crew, r.flag, r.fleet, r.glory,
        r.tz, r.uid, (v_today - interval '45 days')
    FROM tmp_demo_roster r;

    GET DIAGNOSTICS v_members_count = ROW_COUNT;

    -- Step 5: Seed 5 weeks of historical player metrics snapshots
    FOR v_idx IN 1..5 LOOP
        v_w := v_weeks[v_idx];
        v_drift := 1.0 - ((5 - v_idx) * 0.035);

        INSERT INTO public.player_metrics_history (
            pseudo, guild, total_power, tech_power, champion_power,
            crew_power, flagship_power, fleet_rating, glory_score,
            week_start, created_at
        )
        SELECT
            r.pseudo,
            'DEMO',
            round(r.power * v_drift)::bigint,
            round(r.tech * v_drift)::bigint,
            round(r.champ * v_drift)::bigint,
            round(r.crew * v_drift)::bigint,
            round(r.flag * v_drift)::bigint,
            round(r.fleet * v_drift)::bigint,
            round(r.glory * (0.6 + (v_idx * 0.08)))::bigint,
            v_w,
            v_w::timestamptz
        FROM tmp_demo_roster r;
    END LOOP;

    -- Step 6: Seed deterministic active and past event sessions
    INSERT INTO public.event_status (guild, event_name, is_active, session_id, start_at, updated_at) VALUES
        ('DEMO', 'SvS', true, 'SVS-' || to_char(v_cur_week, 'IYYY') || '-W' || to_char(v_cur_week, 'IW'), (v_cur_week + 5 + time '14:00:00')::timestamptz, now()),
        ('DEMO', 'GvG', true, 'GVG-' || to_char(v_cur_week, 'IYYY') || '-W' || to_char(v_cur_week, 'IW'), (v_cur_week + 5 + time '10:00:00')::timestamptz, now()),
        ('DEMO', 'Glory', true, 'GLORY-' || to_char(v_cur_week, 'IYYY') || '-W' || to_char(v_cur_week, 'IW'), v_cur_week::timestamptz, now()),
        ('DEMO', 'Defend Trade Route', false, 'DTR-' || to_char(v_today, 'YYYYMMDD'), (v_today + time '19:00:00')::timestamptz, now()),
        ('DEMO', 'Arms Race Stage A', false, 'ARA-' || to_char(v_today, 'YYYYMMDD'), (v_today + time '12:00:00')::timestamptz, now()),
        ('DEMO', 'Arms Race Stage B', false, 'ARB-' || to_char(v_today, 'YYYYMMDD'), (v_today + time '18:00:00')::timestamptz, now()),
        ('DEMO', 'Shadowfront Squad 1', false, 'SF-' || to_char(v_today, 'YYYYMMDD'), (v_today + time '20:00:00')::timestamptz, now()),
        ('DEMO', 'Shadowfront Squad 2', false, 'SF-' || to_char(v_today, 'YYYYMMDD'), (v_today + time '20:30:00')::timestamptz, now());

    -- Step 7: Populate event participants across all 5 weeks
    FOR v_idx IN 1..5 LOOP
        v_w := v_weeks[v_idx];

        -- 7.1 Glory weekly scores
        v_sid := 'GLORY-' || to_char(v_w, 'IYYY') || '-W' || to_char(v_w, 'IW');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'Glory', v_sid, v_w, r.pseudo,
            1,
            round((r.glory / 5.0) * (0.75 + (r.idx % 5) * 0.06))::int,
            false, false, false, false
        FROM tmp_demo_roster r;

        -- 7.2 SvS Prep and PvP
        v_sid := 'SVS-' || to_char(v_w, 'IYYY') || '-W' || to_char(v_w, 'IW');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, score_prep, score_pvp, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'SVS', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx % 11 = 0 THEN 0 ELSE 1 END,
            CASE WHEN r.idx % 11 = 0 THEN 0 ELSE round((r.power * 0.35) * (0.8 + (r.idx % 4) * 0.1))::int END,
            CASE WHEN r.idx % 11 = 0 THEN 0 ELSE round((r.power * 0.15) * (0.8 + (r.idx % 3) * 0.1))::int END,
            CASE WHEN r.idx % 11 = 0 THEN 0 ELSE round((r.power * 0.20) * (0.8 + (r.idx % 4) * 0.1))::int END,
            false, false,
            (r.idx % 13 = 0),
            (r.idx % 11 = 0)
        FROM tmp_demo_roster r;

        -- 7.3 GvG Prep and PvP
        v_sid := 'GVG-' || to_char(v_w, 'IYYY') || '-W' || to_char(v_w, 'IW');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, score_prep, score_pvp, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'GVG', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx % 9 = 0 THEN 0 ELSE 1 END,
            CASE WHEN r.idx % 9 = 0 THEN 0 ELSE round((r.power * 0.30) * (0.85 + (r.idx % 3) * 0.1))::int END,
            CASE WHEN r.idx % 9 = 0 THEN 0 ELSE round((r.power * 0.12) * (0.8 + (r.idx % 3) * 0.1))::int END,
            CASE WHEN r.idx % 9 = 0 THEN 0 ELSE round((r.power * 0.18) * (0.8 + (r.idx % 4) * 0.1))::int END,
            false, false,
            (r.idx % 15 = 0),
            (r.idx % 9 = 0)
        FROM tmp_demo_roster r;

        -- 7.4 Defend Trade Route (DTR)
        v_sid := 'DTR-' || to_char(v_w + 2, 'YYYYMMDD');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'Defend Trade Route', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx % 8 = 0 THEN 0 ELSE 1 END,
            CASE WHEN r.idx % 8 = 0 THEN 0 ELSE round(850000 + (r.idx * 15000))::int END,
            false, false, false, (r.idx % 8 = 0)
        FROM tmp_demo_roster r;

        -- 7.5 Arms Race Stage A & B
        v_sid := 'ARA-' || to_char(v_w + 1, 'YYYYMMDD');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'Arms Race Stage A', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx % 7 = 0 THEN 0 ELSE 1 END,
            0, false, false, false, (r.idx % 7 = 0)
        FROM tmp_demo_roster r;

        v_sid := 'ARB-' || to_char(v_w + 3, 'YYYYMMDD');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'Arms Race Stage B', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx % 6 = 0 THEN 0 ELSE 1 END,
            0, false, false, false, (r.idx % 6 = 0)
        FROM tmp_demo_roster r;

        -- 7.6 Shadowfront Squad 1 & 2
        v_sid := 'SF-' || to_char(v_w + 4, 'YYYYMMDD');
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'Shadowfront Squad 1', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx <= 25 THEN 1 ELSE 0 END,
            0, false, false, false, false
        FROM tmp_demo_roster r
        WHERE r.idx <= 30;

        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score, is_pending, sub_present, late, excused)
        SELECT
            'DEMO', 'Shadowfront Squad 2', v_sid, v_w, r.pseudo,
            CASE WHEN r.idx BETWEEN 26 AND 50 THEN 1 ELSE 0 END,
            0, false, false, false, false
        FROM tmp_demo_roster r
        WHERE r.idx BETWEEN 26 AND 55;

        -- Step 8: Calculate weekly summary scores for stats & KPI tracking
        FOR v_m IN SELECT pseudo FROM tmp_demo_roster LOOP
            v_pseudo := v_m.pseudo;

            SELECT count(*) INTO v_events_done
            FROM public.event_participants
            WHERE guild = 'DEMO'
              AND pseudo = v_pseudo
              AND week_start = v_w
              AND event_name <> 'Glory'
              AND (participated > 0 OR sub_present = true);

            v_score_20 := round((v_events_done::numeric / 6.0) * 20.0, 1);

            INSERT INTO public.weekly_scores (guild, pseudo, week_start, events_total, events_done, score_20, computed_at)
            VALUES ('DEMO', v_pseudo, v_w, 6, v_events_done, v_score_20, now())
            ON CONFLICT (guild, pseudo, week_start) DO UPDATE SET
                events_total = EXCLUDED.events_total,
                events_done = EXCLUDED.events_done,
                score_20 = EXCLUDED.score_20,
                computed_at = now();
        END LOOP;
    END LOOP;

    -- Step 9: Seed Shadowfront squads composition and signups
    INSERT INTO public.shadowfront_squads (guild, squad, pseudo, role, week_start, session_id, is_commander)
    SELECT
        'DEMO',
        'squad1',
        r.pseudo,
        CASE WHEN r.idx <= 20 THEN 'participant' ELSE 'reserve' END,
        v_cur_week,
        'SF-' || to_char(v_today, 'YYYYMMDD'),
        (r.idx = 1)
    FROM tmp_demo_roster r
    WHERE r.idx <= 25;

    INSERT INTO public.shadowfront_squads (guild, squad, pseudo, role, week_start, session_id, is_commander)
    SELECT
        'DEMO',
        'squad2',
        r.pseudo,
        CASE WHEN r.idx BETWEEN 26 AND 45 THEN 'participant' ELSE 'reserve' END,
        v_cur_week,
        'SF-' || to_char(v_today, 'YYYYMMDD'),
        (r.idx = 26)
    FROM tmp_demo_roster r
    WHERE r.idx BETWEEN 26 AND 50;

    INSERT INTO public.shadowfront_signups (guild, pseudo, week_start, availability, updated_at)
    SELECT
        'DEMO',
        r.pseudo,
        v_cur_week,
        CASE WHEN r.idx <= 25 THEN 'squad1' ELSE 'squad2' END,
        now()
    FROM tmp_demo_roster r
    WHERE r.idx <= 50;

    -- Step 10: Seed realistic disciplinary sanctions and absences
    INSERT INTO public.sanctions (guild, pseudo, comment, created_at) VALUES
        ('DEMO', 'FalconStrike', 'Missed SvS Day 6 battle without prior notice.', (v_today - interval '12 days')),
        ('DEMO', 'MeteorRain', 'Attacked forbidden cargo target during SvS invasion.', (v_today - interval '5 days')),
        ('DEMO', 'DriftRunner', 'Unexcused absence during GvG War Prism clash.', (v_today - interval '2 days'));

    INSERT INTO public.player_absences (guild, pseudo, uid, start_date, end_date, kind, note, created_at, updated_at) VALUES
        ('DEMO', 'NovaCadet', '90000055', (v_today - interval '1 day'), (v_today + interval '6 days'), 'full', 'Business travel abroad - limited roaming data', now(), now()),
        ('DEMO', 'StarRecruit', '90000056', (v_today + interval '2 days'), (v_today + interval '5 days'), 'reduced', 'Medical appointment and recovery', now(), now());

    -- Step 11: Seed sample player name change history
    INSERT INTO public.player_name_history (guild, uid, old_pseudo, new_pseudo, changed_by, changed_at) VALUES
        ('DEMO', '90000001', 'Ares_Old', 'Ares_Actual', 'system', (v_today - interval '40 days')),
        ('DEMO', '90000005', 'IronFist', 'IronClaw', 'system', (v_today - interval '25 days')),
        ('DEMO', '90000013', 'WolfPrime', 'CyberWolf', 'system', (v_today - interval '10 days'));

    -- Step 12: Seed configuration coefficients and notification toggles
    INSERT INTO public.guild_config (guild, key, value, updated_at) VALUES
        ('DEMO', 'server_number', '0000', now()),
        ('DEMO', 'guild_tag', 'DEMO', now()),
        ('DEMO', 'coeff_svs', '5', now()),
        ('DEMO', 'coeff_gvg', '3', now()),
        ('DEMO', 'coeff_shadowfront', '2', now()),
        ('DEMO', 'coeff_dtr', '1', now()),
        ('DEMO', 'coeff_armsrace', '1', now()),
        ('DEMO', 'notify_svs_pvp', 'true', now()),
        ('DEMO', 'notify_gvg_pvp', 'true', now()),
        ('DEMO', 'notify_gvg_daily_tasks', 'true', now()),
        ('DEMO', 'notify_calamity_10', 'true', now()),
        ('DEMO', 'timezone_clocks', 'UTC,Paris (+1),New York (-5),Tokyo (+9)', now())
    ON CONFLICT (guild, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    RETURN jsonb_build_object(
        'ok', true,
        'guild', 'DEMO',
        'members_seeded', v_members_count,
        'weeks_seeded', 5,
        'reset_date', v_today
    );
END;
$$;

-- 3. Execute immediately to test and verify
SELECT public.gm_reset_demo_tenant_data();

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
