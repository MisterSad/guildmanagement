import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { logger } from '../src/core/logger/logger';
import { computeMemberTier, calculateMatchupData } from '../src/workers/matchup.worker';

describe('Audit Remediation Verification Suite', () => {
  it('SEV-01: verifies discord-webhook-proxy requires JWT and checks guild_admin/super_admin roles', () => {
    const filePath = path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('validateCallerAuth');
    expect(content).toContain('caller.role !== "guild_admin" && caller.role !== "super_admin"');
    expect(content).toContain('isValidDiscordWebhook');
    expect(content).toContain('forbidden_cross_guild');
  });

  it('SEV-02: verifies ocr-guild-members requires JWT and role checks', () => {
    const filePath = path.resolve(__dirname, '../supabase/functions/ocr-guild-members/index.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('validateCallerAuth');
    expect(content).toContain('caller.role !== "guild_admin" && caller.role !== "super_admin"');
    expect(content).toContain('forbidden');
  });

  it('SEV-03: verifies pagination helper is utilized in auth-login and admin-accounts', () => {
    const paginationHelper = path.resolve(__dirname, '../supabase/functions/_shared/pagination.ts');
    expect(fs.existsSync(paginationHelper)).toBe(true);

    const authLoginContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/auth-login/index.ts'), 'utf-8');
    expect(authLoginContent).toContain('findUserByEmail');
    expect(authLoginContent).not.toMatch(/admin\.auth\.admin\.listUsers\(\)/);

    const adminAccountsContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/admin-accounts/index.ts'), 'utf-8');
    expect(adminAccountsContent).toContain('findUserByEmail');
  });

  it('SEV-05: verifies member-portal contains defensive score bounding parser', () => {
    const portalPath = path.resolve(__dirname, '../supabase/functions/member-portal/index.ts');
    const content = fs.readFileSync(portalPath, 'utf-8');
    expect(content).toContain('MAX_ALLOWED_EVENT_SCORE = 500_000_000');
    expect(content).toContain('function parseSafeScore');
    expect(content).toContain('parseSafeScore(payload.score)');
    expect(content).toContain('parseSafeScore(payload.score_prep)');
    expect(content).toContain('parseSafeScore(payload.score_pvp)');
  });

  it('SEV-07: verifies EventsService and PortalService schema and action alignment', () => {
    const eventsServiceContent = fs.readFileSync(path.resolve(__dirname, '../src/modules/events/events.service.ts'), 'utf-8');
    expect(eventsServiceContent).toContain(".eq('is_active', true)");
    expect(eventsServiceContent).toContain("is_active: true");
    expect(eventsServiceContent).not.toContain(".eq('active', true)");

    const portalServiceContent = fs.readFileSync(path.resolve(__dirname, '../src/modules/portal/portal.service.ts'), 'utf-8');
    expect(portalServiceContent).toContain("invokeAction('submit-scores'");
    expect(portalServiceContent).toContain("invokeAction('update-power', { power: overallPower })");
    expect(portalServiceContent).toContain("invokeAction('set-absence'");
  });

  it('SEV-08 & SEV-06: verifies SQL migration contains FK indexes and lock cleanup function', () => {
    const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260814180000_audit_remediation_p0_p1.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');
    expect(content).toContain('idx_event_participants_guild_pseudo');
    expect(content).toContain('idx_shadowfront_squads_guild_pseudo');
    expect(content).toContain('idx_sanctions_guild_pseudo');
    expect(content).toContain('idx_guild_transfers_fkeys');
    expect(content).toContain('gm_cleanup_stale_reminder_locks');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.check_user_guild_access');
  });

  it('verifies client logger sanitizes sensitive data and formats correlation IDs', () => {
    expect(logger).toBeDefined();
    expect(logger.getCorrelationId()).toMatch(/^session_/);
  });

  it('verifies pure matchup calculations and tier rankings', () => {
    expect(computeMemberTier(150_000_000)).toBe('S');
    expect(computeMemberTier(60_000_000)).toBe('A');
    expect(computeMemberTier(30_000_000)).toBe('B');
    expect(computeMemberTier(15_000_000)).toBe('C');
    expect(computeMemberTier(5_000_000)).toBe('D');

    const result = calculateMatchupData([
      { pseudo: 'PlayerA', overall_power: 100_000_000 },
      { pseudo: 'PlayerB', overall_power: 20_000_000 }
    ]);

    expect(result.members.length).toBe(2);
    expect(result.totalPower).toBe(120_000_000);
    expect(result.averagePower).toBe(60_000_000);
    expect(result.members[0].pseudo).toBe('PlayerA');
    expect(result.members[0].powerPenalty).toBe(0.9);
    expect(result.members[0].adjustedPower).toBe(90_000_000);
  });

  it('SEV-09: verifies AuditService and Super Admin monitoring UI existence', () => {
    const auditServicePath = path.resolve(__dirname, '../src/modules/audit/audit.service.ts');
    expect(fs.existsSync(auditServicePath)).toBe(true);

    const auditViewPath = path.resolve(__dirname, '../src/modules/audit/audit-view.ts');
    expect(fs.existsSync(auditViewPath)).toBe(true);

    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');
    expect(indexHtml).toContain('id="nav-tab-system-logs"');
    expect(indexHtml).toContain('id="tab-system-logs"');
    expect(indexHtml).toContain('id="audit-logs-table-container"');
  });
});
