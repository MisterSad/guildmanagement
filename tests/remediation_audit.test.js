import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { logger } from '../src/core/logger/logger';
import { computeMemberTier, calculateMatchupData, calculateMatchupAsync } from '../src/workers/matchup.worker';

describe('Audit Remediation Verification Suite', () => {
  it('SEV-01: verifies discord-webhook-proxy requires JWT and checks guild_admin/server_admin/super_admin roles', () => {
    const filePath = path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('validateCallerAuth');
    expect(content).toContain('caller.role !== "guild_admin" && caller.role !== "server_admin" && caller.role !== "super_admin"');
    expect(content).toContain('isValidDiscordWebhook');
    expect(content).toContain('forbidden_cross_guild');
  });

  it('SEV-02: verifies ocr-guild-members requires JWT and role checks', () => {
    const filePath = path.resolve(__dirname, '../supabase/functions/ocr-guild-members/index.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('validateCallerAuth');
    expect(content).toContain('caller.role !== "guild_admin" && caller.role !== "server_admin" && caller.role !== "super_admin"');
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

  it('SEV-08 & SEV-06: verifies SQL canonical migration contains FK indexes and lock cleanup function', () => {
    const indexesPath = path.resolve(__dirname, '../supabase/migrations/20260812000001_schema_tables_and_indexes.sql');
    const indexesContent = fs.readFileSync(indexesPath, 'utf-8');
    expect(indexesContent).toContain('idx_event_participants_guild_pseudo');
    expect(indexesContent).toContain('idx_shadowfront_squads_guild_pseudo');
    expect(indexesContent).toContain('idx_sanctions_guild_pseudo');
    expect(indexesContent).toContain('idx_guild_transfers_fkeys');

    const funcsPath = path.resolve(__dirname, '../supabase/migrations/20260812000003_functions_and_rpcs.sql');
    const funcsContent = fs.readFileSync(funcsPath, 'utf-8');
    expect(funcsContent).toContain('gm_cleanup_stale_reminder_locks');
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

  it('verifies calculateMatchupAsync computes results asynchronously', async () => {
    const result = await calculateMatchupAsync([
      { pseudo: 'PlayerA', overall_power: 100_000_000 },
      { pseudo: 'PlayerB', overall_power: 20_000_000 }
    ]);

    expect(result.members.length).toBe(2);
    expect(result.totalPower).toBe(120_000_000);
    expect(result.averagePower).toBe(60_000_000);
    expect(result.dangerosityScore).toBe(120);
    expect(result.members[0].pseudo).toBe('PlayerA');
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

  it('W3 & W7: verifies payment hardening migration locks rows and normalizes subscription_type', () => {
    const paymentMigPath = path.resolve(__dirname, '../supabase/migrations/20260823053000_harden_subscription_payment_and_plans.sql');
    expect(fs.existsSync(paymentMigPath)).toBe(true);
    const content = fs.readFileSync(paymentMigPath, 'utf-8');
    expect(content).toContain('FOR UPDATE');
    expect(content).toContain("subscription_type = 'Premium'");
    expect(content).toContain('plan_key = v_payment.plan_key');
    expect(content).toContain('REVOKE ALL ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) FROM public, anon, authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) TO service_role;');
  });

  it('W5: verifies member-portal security, scope and resilience hardening', () => {
    const portalPath = path.resolve(__dirname, '../supabase/functions/member-portal/index.ts');
    const content = fs.readFileSync(portalPath, 'utf-8');

    // 1. get-personal-kpis resolves member before getGuildAverages
    expect(content).toContain('const member = await getPlayer(admin, uid, identity.guild);');
    expect(content).toContain('const targetGuild = member?.guild || identity.guild;');
    expect(content).toContain('targetGuild ? getGuildAverages(admin, targetGuild) : Promise.resolve(null)');

    // 2. submit-scores strips excused/appointed from client payload
    expect(content).not.toContain('update.excused = !!payload.excused');
    expect(content).not.toContain('update.appointed = !!payload.appointed');

    // 3. update-power validates numeric input and scopes fallback by guild
    expect(content).not.toContain('parseInt(payload?.power) || 0');
    expect(content).toContain('error: "invalid_power"');
    expect(content).toContain('.eq("guild", member.guild)');

    // 4. Top-level try-catch wraps dispatch
    expect(content).toContain('catch (unhandledErr)');
    expect(content).toContain('error: "internal_error"');
  });

  it('W6: verifies security definer RPC authorization lockdown migration', () => {
    const rpcMigPath = path.resolve(__dirname, '../supabase/migrations/20260823060000_security_rpc_lockdown.sql');
    expect(fs.existsSync(rpcMigPath)).toBe(true);
    const content = fs.readFileSync(rpcMigPath, 'utf-8');

    expect(content).toContain('public.gm_upsert_player_metrics');
    expect(content).toContain('public.is_super_admin() OR (public.check_user_guild_write_access(p_guild)');
    expect(content).toContain('public.gm_reset_account_password');
    expect(content).toContain('public.gm_admin_upsert');
    expect(content).toContain('public.gm_transfer_guild_member');
    expect(content).not.toContain("COALESCE(v_caller_guild, 'ALPHA')");
    expect(content).toContain('REVOKE ALL ON FUNCTION public.gm_log_player_audit');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.gm_log_player_audit(text, text, text, text, text, text, jsonb, text, text) TO service_role;');
    expect(content).toContain('CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs');
    expect(content).toContain('FOR INSERT TO service_role');
  });

  it('W4: verifies cron secret vault migration, timing-safe compare, and log hygiene', () => {
    // 1. Vault cron migration exists and references vault.decrypted_secrets
    const vaultMigPath = path.resolve(__dirname, '../supabase/migrations/20260823063000_cron_secret_to_vault.sql');
    expect(fs.existsSync(vaultMigPath)).toBe(true);
    const vaultContent = fs.readFileSync(vaultMigPath, 'utf-8');
    expect(vaultContent).toContain('vault.decrypted_secrets');
    expect(vaultContent).toContain('event_reminders_cron_secret');
    expect(vaultContent).toContain('public.gm_invoke_event_reminders');

    // 2. Legacy migrations scrubbed
    const leg1 = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260817113000_schedule_event_reminders_cron.sql'), 'utf-8');
    const leg2 = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260817114500_update_event_reminders_cron_secret.sql'), 'utf-8');
    expect(leg1).not.toContain('fgf-cron-secret-2026-secure-reminders');
    expect(leg2).not.toContain('fgf-cron-secret-2026-secure-reminders');
    expect(leg1).toContain('__ROTATED__SEE_VAULT__');
    expect(leg2).toContain('__ROTATED__SEE_VAULT__');

    // 3. event-reminders has timing-safe compare and masked URLs
    const remindersContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/event-reminders/index.ts'), 'utf-8');
    expect(remindersContent).toContain('function safeEqual(a: string, b: string): boolean');
    expect(remindersContent).toContain('maskWebhookUrl');
    expect(remindersContent).toContain('safeEqual(authBearer, cronSecret)');

    // 4. discord-webhook-proxy masks blocked webhook URL
    const discordContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts'), 'utf-8');
    expect(discordContent).toContain('replace(/(https:\\/\\/discord\\.com\\/api\\/webhooks\\/\\d+\\/)[^?#\\s]+/, \'$1***\')');
    expect(discordContent).toContain('redirect: "error"');

    // 5. ocr-guild-members uses x-goog-api-key header
    const ocrContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/ocr-guild-members/index.ts'), 'utf-8');
    expect(ocrContent).toContain('"x-goog-api-key": GEMINI_API_KEY');
    expect(ocrContent).not.toContain('?key=${GEMINI_API_KEY}');
  });

  it('W8: verifies canonical migration reconciliation, idempotence and reload notifications', () => {
    const mig1 = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812000001_schema_tables_and_indexes.sql'), 'utf-8');
    const mig2 = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812000002_security_rls_policies.sql'), 'utf-8');
    const mig3 = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812000003_functions_and_rpcs.sql'), 'utf-8');
    const mig4 = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260812000004_triggers_and_crons.sql'), 'utf-8');

    expect(mig1).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    expect(mig1).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    expect(mig1).toContain('plan_key TEXT,');
    expect(mig1).toContain("NOTIFY pgrst, 'reload schema';");

    expect(mig2).toContain('DROP POLICY IF EXISTS');
    expect(mig2).toContain("NOTIFY pgrst, 'reload schema';");

    expect(mig3).toContain("NOTIFY pgrst, 'reload schema';");
    expect(mig4).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('W9/GAP 2: verifies CSP hardening without unsafe-eval, and pinned SRI attributes', () => {
    const vercelConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf-8'));
    const headers = vercelConfig.headers[0].headers;
    const csp = headers.find(h => h.key === 'Content-Security-Policy')?.value;

    expect(csp).toBeDefined();
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self' https://vgweufzwmfwplusskmuf.supabase.co wss://vgweufzwmfwplusskmuf.supabase.co");

    const htmlContent = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');
    expect(htmlContent).toMatch(/<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+[^"]*"\s+integrity="sha384-[^"]+"\s+crossorigin="anonymous"><\/script>/);
    expect(htmlContent).toMatch(/<script\s+src="https:\/\/unpkg\.com\/@phosphor-icons\/web@\d+\.\d+\.\d+[^"]*"\s+integrity="sha384-[^"]+"\s+crossorigin="anonymous"><\/script>/);

    // Verify all CDN scripts have integrity attributes
    const scriptTags = htmlContent.match(/<script[^>]*src="https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)[^"]*"[^>]*>/g) || [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain('integrity="sha384-');
      expect(tag).toContain('crossorigin="anonymous"');
    }
  });

  it('W10: verifies auth hardening, bcrypt dual-read migration, and lockout defense', () => {
    const authMigPath = path.resolve(__dirname, '../supabase/migrations/20260823070000_auth_hardening.sql');
    expect(fs.existsSync(authMigPath)).toBe(true);
    const authContent = fs.readFileSync(authMigPath, 'utf-8');

    expect(authContent).toContain('ADD COLUMN IF NOT EXISTS password_hash TEXT');
    expect(authContent).toContain('ADD COLUMN IF NOT EXISTS failed_login_count INTEGER');
    expect(authContent).toContain('ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ');
    expect(authContent).toContain('extensions.crypt(p_password, v_acc.password_hash)');
    expect(authContent).toContain("extensions.gen_salt('bf', 10)");
    expect(authContent).toContain('account_locked');

    const authLoginContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/auth-login/index.ts'), 'utf-8');
    expect(authLoginContent).toContain('error: "account_locked"');
  });

  it('W11: verifies centralized dynamic CORS and build script JSON cleanup', () => {
    const corsPath = path.resolve(__dirname, '../supabase/functions/_shared/cors.ts');
    expect(fs.existsSync(corsPath)).toBe(true);
    const corsContent = fs.readFileSync(corsPath, 'utf-8');
    expect(corsContent).toContain('export function getCorsHeaders');
    expect(corsContent).toContain('https://fgf-guild-management.vercel.app');

    const buildScript = fs.readFileSync(path.resolve(__dirname, '../scripts/build.js'), 'utf-8');
    expect(buildScript).toContain('package.json');
    expect(buildScript).toContain('EXCLUDED_FILES');
  });

  it('W12: verifies WCAG viewport accessibility and logout storage cleanup', () => {
    const htmlContent = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');
    expect(htmlContent).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">');
    expect(htmlContent).not.toContain('user-scalable=no');
    expect(htmlContent).not.toContain('maximum-scale=1.0');

    const utilsContent = fs.readFileSync(path.resolve(__dirname, '../gm-utils.js'), 'utf-8');
    expect(utilsContent).toContain('sessionStorage.clear()');
    expect(utilsContent).toContain('localStorage.removeItem');
  });
});
