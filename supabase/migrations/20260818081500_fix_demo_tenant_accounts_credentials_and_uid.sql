-- ==============================================================================
-- MIGRATION: 20260818081500_fix_demo_tenant_accounts_credentials_and_uid.sql
-- DESCRIPTION: Ensure DemoAdmin and DemoPlayer have encrypted password demo1234
--              and DemoPlayer is linked to UID 90000002 for Player Portal access.
-- ==============================================================================

-- 1. Redefine public.gm_reset_demo_tenant_data() with encrypted credentials and member UID
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
    DELETE FROM public.event_reminders_sent WHERE guild = 'DEMO';
    DELETE FROM public.discord_notifications_sent WHERE guild = 'DEMO';
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

    -- Step 4: Guild configuration (join code & coefficients)
    INSERT INTO public.guild_config (guild, key, value, updated_at) VALUES
        ('DEMO', 'join_code_plain', 'FGF-DEMO-0000', now()),
        ('DEMO', 'join_code_hash', encode(sha256('FGF-DEMO-0000'::bytea), 'hex'), now()),
        ('DEMO', 'coeff_armsrace', '1', now()),
        ('DEMO', 'coeff_dtr', '2', now()),
        ('DEMO', 'coeff_gvg', '5', now()),
        ('DEMO', 'coeff_shadowfront', '3', now()),
        ('DEMO', 'coeff_svs', '5', now()),
        ('DEMO', 'reserve_credit_pct', '50', now())
    ON CONFLICT (guild, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    -- Step 5: Populate 60 fictional members with full 7 military metrics
    FOR v_idx IN 1..60 LOOP
        v_uid := (90000000 + v_idx)::text;

        v_pseudo := CASE v_idx
            WHEN 1 THEN 'Nova'
            WHEN 2 THEN 'Valkyrie'
            WHEN 3 THEN 'Orion'
            WHEN 4 THEN 'Vega'
            WHEN 5 THEN 'Atlas'
            WHEN 6 THEN 'Rhea'
            WHEN 7 THEN 'Zephyr'
            WHEN 8 THEN 'Lyra'
            WHEN 9 THEN 'Cyrus'
            WHEN 10 THEN 'Nyx'
            WHEN 11 THEN 'Draco'
            WHEN 12 THEN 'Andra'
            WHEN 13 THEN 'Mira'
            WHEN 14 THEN 'Kael'
            WHEN 15 THEN 'Sable'
            WHEN 16 THEN 'Talon'
            WHEN 17 THEN 'Echo'
            WHEN 18 THEN 'Bex'
            WHEN 19 THEN 'Iris'
            WHEN 20 THEN 'Juno'
            WHEN 21 THEN 'Kira'
            WHEN 22 THEN 'Lobo'
            WHEN 23 THEN 'Mako'
            WHEN 24 THEN 'Nemo'
            WHEN 25 THEN 'Onyx'
            WHEN 26 THEN 'Pike'
            WHEN 27 THEN 'Quill'
            WHEN 28 THEN 'Rex'
            WHEN 29 THEN 'Stella'
            WHEN 30 THEN 'Tycho'
            WHEN 31 THEN 'Umbra'
            WHEN 32 THEN 'Vex'
            WHEN 33 THEN 'Wren'
            WHEN 34 THEN 'Xena'
            WHEN 35 THEN 'Yuki'
            WHEN 36 THEN 'Zeno'
            WHEN 37 THEN 'Aria'
            WHEN 38 THEN 'Blaze'
            WHEN 39 THEN 'Cinder'
            WHEN 40 THEN 'Dune'
            WHEN 41 THEN 'Ember'
            WHEN 42 THEN 'Frost'
            WHEN 43 THEN 'Ghost'
            WHEN 44 THEN 'Havoc'
            WHEN 45 THEN 'Iron'
            WHEN 46 THEN 'Jett'
            WHEN 47 THEN 'Koda'
            WHEN 48 THEN 'Lux'
            WHEN 49 THEN 'Nash'
            WHEN 50 THEN 'Odin'
            WHEN 51 THEN 'Piper'
            WHEN 52 THEN 'Rogue'
            WHEN 53 THEN 'Slate'
            WHEN 54 THEN 'Titan'
            WHEN 55 THEN 'Ulan'
            WHEN 56 THEN 'Viper'
            WHEN 57 THEN 'Wolf'
            WHEN 58 THEN 'Aster'
            WHEN 59 THEN 'Bolt'
            ELSE 'Comet'
        END;

        IF v_idx = 1 THEN
            v_role := 'R5';
            v_power := 168000000;
            v_tech := 58000000;
            v_champ := 42000000;
            v_crew := 36000000;
            v_flag := 22000000;
            v_fleet := 125000000;
            v_glory := 385000000;
            v_tz := 1;
        ELSIF v_idx <= 5 THEN
            v_role := 'R4';
            v_power := 120000000 - (v_idx * 6000000);
            v_tech := (v_power * 0.35)::bigint;
            v_champ := (v_power * 0.25)::bigint;
            v_crew := (v_power * 0.22)::bigint;
            v_flag := (v_power * 0.14)::bigint;
            v_fleet := (v_power * 0.85)::bigint;
            v_glory := (v_power * 2.2)::bigint;
            v_tz := CASE v_idx WHEN 2 THEN 2 WHEN 3 THEN -5 WHEN 4 THEN 0 ELSE 1 END;
        ELSIF v_idx <= 18 THEN
            v_role := 'R3';
            v_power := 78000000 - ((v_idx - 5) * 2500000);
            v_tech := (v_power * 0.33)::bigint;
            v_champ := (v_power * 0.24)::bigint;
            v_crew := (v_power * 0.23)::bigint;
            v_flag := (v_power * 0.12)::bigint;
            v_fleet := (v_power * 0.80)::bigint;
            v_glory := (v_power * 1.8)::bigint;
            v_tz := (v_idx % 8) - 5;
        ELSIF v_idx <= 42 THEN
            v_role := 'R2';
            v_power := 42000000 - ((v_idx - 18) * 900000);
            v_tech := (v_power * 0.31)::bigint;
            v_champ := (v_power * 0.22)::bigint;
            v_crew := (v_power * 0.24)::bigint;
            v_flag := (v_power * 0.10)::bigint;
            v_fleet := (v_power * 0.75)::bigint;
            v_glory := (v_power * 1.5)::bigint;
            v_tz := (v_idx % 9) - 6;
        ELSE
            v_role := 'R1';
            v_power := 20000000 - ((v_idx - 42) * 500000);
            v_tech := (v_power * 0.28)::bigint;
            v_champ := (v_power * 0.20)::bigint;
            v_crew := (v_power * 0.26)::bigint;
            v_flag := (v_power * 0.08)::bigint;
            v_fleet := (v_power * 0.70)::bigint;
            v_glory := (v_power * 1.2)::bigint;
            v_tz := (v_idx % 6) - 3;
        END IF;

        INSERT INTO public.guild_members (
            uid, pseudo, guild, overall_power, tech_power, champion_power, crew_power,
            flagship_power, fleet_rating, glory_score, role, timezone_offset,
            power_updated_at, metrics_updated_at, created_at
        ) VALUES (
            v_uid, v_pseudo, 'DEMO', v_power, v_tech, v_champ, v_crew,
            v_flag, v_fleet, v_glory, v_role, v_tz,
            now(), now(), now() - interval '60 days'
        );

        v_members_count := v_members_count + 1;
    END LOOP;

    -- Step 6: Populate 5 weeks of history across player_metrics_history, event_participants, weekly_scores
    FOREACH v_w IN ARRAY v_weeks LOOP
        v_idx := 0;
        FOR v_m IN (SELECT * FROM public.guild_members WHERE guild = 'DEMO' ORDER BY id ASC) LOOP
            v_idx := v_idx + 1;
            v_drift := 0.82 + (0.045 * array_position(v_weeks, v_w));

            -- A. player_metrics_history
            INSERT INTO public.player_metrics_history (
                guild, pseudo, week_start, total_power, tech_power, champion_power, crew_power,
                flagship_power, fleet_rating, glory_score, created_at
            ) VALUES (
                'DEMO', v_m.pseudo, v_w,
                (v_m.overall_power * v_drift)::bigint,
                (v_m.tech_power * v_drift)::bigint,
                (v_m.champion_power * v_drift)::bigint,
                (v_m.crew_power * v_drift)::bigint,
                (v_m.flagship_power * v_drift)::bigint,
                (v_m.fleet_rating * v_drift)::bigint,
                (v_m.glory_score * v_drift)::bigint,
                v_w + time '12:00:00'
            )
            ON CONFLICT (guild, pseudo, week_start) DO UPDATE SET
                total_power = EXCLUDED.total_power,
                tech_power = EXCLUDED.tech_power,
                champion_power = EXCLUDED.champion_power,
                crew_power = EXCLUDED.crew_power,
                flagship_power = EXCLUDED.flagship_power,
                fleet_rating = EXCLUDED.fleet_rating,
                glory_score = EXCLUDED.glory_score;

            -- B. Glory Event Participants
            v_sid := public.gm_event_session_id('Glory', v_w);
            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, late, excused, appointed, sub_present
            ) VALUES (
                'Glory', 'DEMO', v_m.pseudo, v_sid, v_w, 1,
                (v_m.glory_score * v_drift)::int, false, false, false, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                score = EXCLUDED.score, participated = 1;

            -- C. SvS Event Participants
            v_sid := public.gm_event_session_id('SvS', v_w);
            v_part := CASE WHEN (v_idx % 7 = 0 AND v_idx > 10) THEN 0 ELSE 1 END;
            v_excused := (v_part = 0 AND v_idx % 14 = 0);
            v_late := (v_part = 1 AND v_idx % 9 = 0);
            v_score_prep := CASE WHEN v_part = 1 THEN ((v_m.overall_power / 350) * (0.8 + (v_idx % 5) * 0.1))::int ELSE 0 END;
            v_score_pvp := CASE WHEN v_part = 1 THEN ((v_m.overall_power / 180) * (0.7 + (v_idx % 6) * 0.1))::int ELSE 0 END;

            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, score_prep, score_pvp, late, excused, appointed, sub_present
            ) VALUES (
                'SvS', 'DEMO', v_m.pseudo, v_sid, v_w, v_part,
                (v_score_prep + v_score_pvp), v_score_prep, v_score_pvp,
                v_late, v_excused, false, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                participated = EXCLUDED.participated, score = EXCLUDED.score;

            -- D. GvG Event Participants
            v_sid := public.gm_event_session_id('GvG', v_w);
            v_part := CASE WHEN (v_idx % 8 = 0 AND v_idx > 12) THEN 0 ELSE 1 END;
            v_excused := (v_part = 0 AND v_idx % 16 = 0);
            v_late := (v_part = 1 AND v_idx % 11 = 0);
            v_score_prep := CASE WHEN v_part = 1 THEN ((v_m.overall_power / 400) * (0.8 + (v_idx % 4) * 0.1))::int ELSE 0 END;
            v_score_pvp := CASE WHEN v_part = 1 THEN ((v_m.overall_power / 220) * (0.7 + (v_idx % 5) * 0.1))::int ELSE 0 END;

            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, score_prep, score_pvp, late, excused, appointed, sub_present
            ) VALUES (
                'GvG', 'DEMO', v_m.pseudo, v_sid, v_w, v_part,
                (v_score_prep + v_score_pvp), v_score_prep, v_score_pvp,
                v_late, v_excused, false, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                participated = EXCLUDED.participated, score = EXCLUDED.score;

            -- E. Defend Trade Route (DTR)
            v_sid := public.gm_event_session_id('Defend Trade Route', v_w + 2);
            v_part := CASE WHEN (v_idx % 6 = 0 AND v_idx > 20) THEN 0 ELSE 1 END;
            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, late, excused, appointed, sub_present
            ) VALUES (
                'Defend Trade Route', 'DEMO', v_m.pseudo, v_sid, v_w, v_part,
                v_part, false, false, false, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                participated = EXCLUDED.participated, score = EXCLUDED.score;

            -- F. Arms Race Stage A & B
            v_sid := public.gm_event_session_id('ARMS RACE STAGE A', v_w + 3);
            v_part := CASE WHEN (v_idx % 5 = 0 AND v_idx > 30) THEN 0 ELSE 1 END;
            v_score := CASE WHEN v_part = 1 THEN (2500000 + (v_idx * 150000)) ELSE 0 END;
            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, late, excused, appointed, sub_present
            ) VALUES (
                'ARMS RACE STAGE A', 'DEMO', v_m.pseudo, v_sid, v_w, v_part,
                v_score, false, false, false, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                participated = EXCLUDED.participated, score = EXCLUDED.score;

            v_sid := public.gm_event_session_id('ARMS RACE STAGE B', v_w + 4);
            v_part := CASE WHEN (v_idx % 5 = 0 AND v_idx > 25) THEN 0 ELSE 1 END;
            v_score := CASE WHEN v_part = 1 THEN (3000000 + (v_idx * 180000)) ELSE 0 END;
            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, late, excused, appointed, sub_present
            ) VALUES (
                'ARMS RACE STAGE B', 'DEMO', v_m.pseudo, v_sid, v_w, v_part,
                v_score, false, false, false, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                participated = EXCLUDED.participated, score = EXCLUDED.score;

            -- G. Weekly Scores Calculation
            v_events_done := 6 - (v_idx % 2);
            v_score_20 := ROUND((15.0 + ((v_idx % 5) * 1.0) + (0.5 * array_position(v_weeks, v_w))), 1);
            IF v_score_20 > 20.0 THEN v_score_20 := 20.0; END IF;

            INSERT INTO public.weekly_scores (
                guild, week_start, pseudo, score_20, events_done, events_total, glory_score, computed_at
            ) VALUES (
                'DEMO', v_w, v_m.pseudo, v_score_20, v_events_done, 6,
                (v_m.glory_score * v_drift)::int, v_w + time '23:59:00'
            )
            ON CONFLICT (guild, week_start, pseudo) DO UPDATE SET
                score_20 = EXCLUDED.score_20,
                events_done = EXCLUDED.events_done,
                glory_score = EXCLUDED.glory_score;
        END LOOP;
    END LOOP;

    -- Step 7: Shadowfront Squads & Signups
    FOREACH v_w IN ARRAY v_weeks LOOP
        v_sid := public.gm_event_session_id('Shadowfront Squad 1', v_w + 5);
        v_idx := 0;
        FOR v_m IN (SELECT * FROM public.guild_members WHERE guild = 'DEMO' ORDER BY id ASC LIMIT 30) LOOP
            v_idx := v_idx + 1;
            INSERT INTO public.shadowfront_squads (
                guild, week_start, pseudo, squad, role, session_id, is_commander
            ) VALUES (
                'DEMO', v_w, v_m.pseudo,
                CASE WHEN v_idx <= 15 THEN 'squad1' ELSE 'squad2' END,
                CASE WHEN (v_idx <= 10 OR (v_idx > 15 AND v_idx <= 25)) THEN 'participant' ELSE 'reserve' END,
                v_sid,
                (v_idx = 1 OR v_idx = 16)
            )
            ON CONFLICT (guild, week_start, pseudo) DO UPDATE SET
                squad = EXCLUDED.squad, role = EXCLUDED.role, is_commander = EXCLUDED.is_commander;

            -- Signups
            INSERT INTO public.shadowfront_signups (
                guild, week_start, pseudo, availability, updated_at
            ) VALUES (
                'DEMO', to_char(v_w, 'YYYY-MM-DD'), v_m.pseudo,
                CASE WHEN v_idx % 3 = 0 THEN 'squad1'
                     WHEN v_idx % 3 = 1 THEN 'squad2'
                     ELSE 'both' END,
                v_w + time '18:00:00'
            )
            ON CONFLICT (guild, week_start, pseudo) DO UPDATE SET
                availability = EXCLUDED.availability;

            -- Shadowfront Event Participant record
            INSERT INTO public.event_participants (
                event_name, guild, pseudo, session_id, week_start, participated,
                score, late, excused, appointed, sub_present
            ) VALUES (
                'Shadowfront', 'DEMO', v_m.pseudo, v_sid, v_w, 1,
                NULL, false, false, true, false
            )
            ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE SET
                participated = 1, appointed = true;
        END LOOP;
    END LOOP;

    -- Step 8: Active and Latest Event Status
    INSERT INTO public.event_status (guild, event_name, is_active, stage, session_id, start_at, updated_at) VALUES
        ('DEMO', 'Glory', true, NULL, public.gm_event_session_id('Glory', v_cur_week), v_cur_week + time '00:00:00', now()),
        ('DEMO', 'SvS', false, NULL, public.gm_event_session_id('SvS', v_cur_week), v_cur_week + 5 + time '14:00:00', now()),
        ('DEMO', 'GvG', false, NULL, public.gm_event_session_id('GvG', v_cur_week), v_cur_week + 4 + time '10:00:00', now()),
        ('DEMO', 'Defend Trade Route', false, NULL, public.gm_event_session_id('Defend Trade Route', v_cur_week + 2), v_cur_week + 2 + time '19:00:00', now()),
        ('DEMO', 'ARMS RACE STAGE A', false, 'A', public.gm_event_session_id('ARMS RACE STAGE A', v_cur_week + 3), v_cur_week + 3 + time '17:00:00', now()),
        ('DEMO', 'ARMS RACE STAGE B', false, 'B', public.gm_event_session_id('ARMS RACE STAGE B', v_cur_week + 4), v_cur_week + 4 + time '17:00:00', now()),
        ('DEMO', 'Shadowfront Squad 1', false, NULL, public.gm_event_session_id('Shadowfront Squad 1', v_cur_week + 5), v_cur_week + 5 + time '18:00:00', now()),
        ('DEMO', 'Shadowfront Squad 2', false, NULL, public.gm_event_session_id('Shadowfront Squad 2', v_cur_week + 5), v_cur_week + 5 + time '23:00:00', now())
    ON CONFLICT (guild, event_name) DO UPDATE SET
        is_active = EXCLUDED.is_active,
        session_id = EXCLUDED.session_id,
        stage = EXCLUDED.stage,
        start_at = EXCLUDED.start_at,
        updated_at = now();

    -- Step 9: Disciplinary Sanctions Sample Data
    INSERT INTO public.sanctions (guild, pseudo, comment, created_by, created_at) VALUES
        ('DEMO', 'Koda', 'Warning: Missed SvS battle without prior notice.', 'DemoAdmin', now() - interval '6 days'),
        ('DEMO', 'Piper', 'Warning: Arrived 25 minutes late for GvG coordinate strike.', 'DemoAdmin', now() - interval '12 days'),
        ('DEMO', 'Viper', 'Demotion: Inactivity during scheduled Shadowfront deployment.', 'DemoAdmin', now() - interval '18 days');

    -- Step 10: Player Absences Sample Data
    INSERT INTO public.player_absences (guild, pseudo, uid, start_date, end_date, kind, note, created_at, updated_at) VALUES
        ('DEMO', 'Atlas', '90000005', v_cur_week + 1, v_cur_week + 7, 'full', 'Vacation deployment in Sector 4', now(), now()),
        ('DEMO', 'Bex', '90000018', v_cur_week + 3, v_cur_week + 5, 'reduced', 'Available for evening SvS only', now(), now());

    -- Step 11: Player Name History Sample Data
    INSERT INTO public.player_name_history (guild, uid, old_pseudo, new_pseudo, changed_by, changed_at) VALUES
        ('DEMO', '90000001', 'StarNova', 'Nova', 'DemoAdmin', now() - interval '30 days'),
        ('DEMO', '90000003', 'OrionPrime', 'Orion', 'DemoAdmin', now() - interval '45 days');

    RETURN jsonb_build_object(
        'ok', true,
        'guild', 'DEMO',
        'members_seeded', v_members_count,
        'weeks_seeded', array_length(v_weeks, 1),
        'current_week', to_char(v_cur_week, 'YYYY-MM-DD'),
        'reset_at', now()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gm_reset_demo_tenant_data() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_reset_demo_tenant_data() TO authenticated, service_role;

-- 2. Ensure accounts in DB are initialized immediately
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

-- 3. Execute immediately to populate DEMO tenant and members
SELECT public.gm_reset_demo_tenant_data();

NOTIFY pgrst, 'reload schema';
