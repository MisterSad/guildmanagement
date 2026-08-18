import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildEventSessionId, isoWeekKey, dateKey } from '../src/core/config/events.ts';
import '../gm-utils.js';

describe('DEMO Tenant Dynamic Data & Daily Reset Automation', () => {
    const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260818030000_demo_tenant_dynamic_data_and_daily_reset.sql');
    const devSeedPath = path.resolve(__dirname, '../supabase/seeds/dev_seed.sql');
    const pythonScriptPath = path.resolve(__dirname, '../scripts/generate_demo_data.py');

    beforeEach(() => {
        window.guildsData = {
            ALPHA: { type: 'Unlimited', paymentsDisabled: false },
            DEMO: { type: 'Unlimited', paymentsDisabled: true },
        };
    });

    it('verifies migration file exists and contains gm_reset_demo_tenant_data with Security Definer', () => {
        expect(fs.existsSync(migrationPath)).toBe(true);
        const content = fs.readFileSync(migrationPath, 'utf-8');

        expect(content).toContain('CREATE OR REPLACE FUNCTION public.gm_reset_demo_tenant_data()');
        expect(content).toContain('SECURITY DEFINER');
        expect(content).toContain("SET search_path TO ''");
        expect(content).toContain('REVOKE ALL ON FUNCTION public.gm_reset_demo_tenant_data() FROM public, anon');
        expect(content).toContain('GRANT EXECUTE ON FUNCTION public.gm_reset_demo_tenant_data() TO authenticated, service_role');
    });

    it('verifies pg_cron daily reset is scheduled at 03:00 UTC', () => {
        const content = fs.readFileSync(migrationPath, 'utf-8');
        expect(content).toContain("'daily-demo-tenant-reset'");
        expect(content).toContain("'0 3 * * *'");
        expect(content).toContain('SELECT public.gm_reset_demo_tenant_data()');
    });

    it('verifies dev_seed.sql calls gm_reset_demo_tenant_data()', () => {
        expect(fs.existsSync(devSeedPath)).toBe(true);
        const content = fs.readFileSync(devSeedPath, 'utf-8');
        expect(content).toContain('SELECT public.gm_reset_demo_tenant_data();');
    });

    it('verifies python generator script exists and supports 7 military power metrics', () => {
        expect(fs.existsSync(pythonScriptPath)).toBe(true);
        const content = fs.readFileSync(pythonScriptPath, 'utf-8');
        expect(content).toContain('tech_power');
        expect(content).toContain('champion_power');
        expect(content).toContain('crew_power');
        expect(content).toContain('flagship_power');
        expect(content).toContain('fleet_rating');
        expect(content).toContain('glory_score');
        expect(content).toContain('player_metrics_history');
    });

    it('verifies deterministic session IDs conform to SaaS specifications', () => {
        const testDate = new Date('2026-08-18T12:00:00Z');
        const isoKey = isoWeekKey(testDate);
        const dKey = dateKey(testDate);

        expect(buildEventSessionId('SvS', testDate)).toBe(`SVS-${isoKey}`);
        expect(buildEventSessionId('GvG', testDate)).toBe(`GVG-${isoKey}`);
        expect(buildEventSessionId('Glory', testDate)).toBe(`GLORY-${isoKey}`);
        expect(buildEventSessionId('ARMS RACE STAGE A', testDate)).toBe(`ARA-${dKey}-1`);
        expect(buildEventSessionId('ARMS RACE STAGE B', testDate)).toBe(`ARB-${dKey}-1`);
        expect(buildEventSessionId('Defend Trade Route', testDate)).toBe(`DTR-${dKey}-1`);
        expect(buildEventSessionId('Shadowfront Squad 1', testDate)).toBe(`SF1-${dKey}-1`);
        expect(buildEventSessionId('Shadowfront Squad 2', testDate)).toBe(`SF2-${dKey}-1`);
    });

    it('verifies DEMO guild is recognized as payments disabled and isolated', () => {
        const GM = window.GM;
        expect(GM.isPaymentsDisabled('DEMO')).toBe(true);
    });

    it('verifies DemoAdmin and DemoPlayer accounts are initialized with demo1234 encrypted passwords and DemoPlayer has UID', () => {
        const migrationContent = fs.readFileSync(migrationPath, 'utf-8');
        expect(migrationContent).toContain("'DemoAdmin'");
        expect(migrationContent).toContain("'DemoPlayer'");
        expect(migrationContent).toContain("extensions.pgp_sym_encrypt('demo1234'");
        expect(migrationContent).toContain("'90000002'");

        const pyContent = fs.readFileSync(pythonScriptPath, 'utf-8');
        expect(pyContent).toContain("'DemoAdmin'");
        expect(pyContent).toContain("'DemoPlayer'");
        expect(pyContent).toContain("extensions.pgp_sym_encrypt('demo1234'");
        expect(pyContent).toContain("'90000002'");
    });
});
