// Regression guards for the bug-report ticketing system (V3.5.3): any
// guild_admin / server_admin / super_admin can report a bug; the ticket is
// persisted (global sequential number), sent to a central Discord webhook via
// the SSRF-safe proxy, and listed/managed by the super admin.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import '../gm-utils.js';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Bug-report ticketing (V3.5.3)', () => {
  it('the tickets migration is service-role safe and gates the 3 admin roles', () => {
    const migration = read('supabase/migrations/20260824113700_tickets.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.tickets');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.gm_create_ticket');
    // The reporter must be resolved from auth.uid() on the browser path and the
    // gate must reject member + anonymous callers
    expect(migration).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN[\s\S]*?role NOT IN \('super_admin', 'server_admin', 'guild_admin'\)/);
    expect(migration).toContain("'forbidden'::text");
    // Service-role path trusts the explicit reporter (Edge already authorized)
    expect(migration).toMatch(/ELSE[\s\S]*?v_reporter_account := p_reporter_account_id/);
    // Grants hygiene + PostgREST reload
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_create_ticket/);
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.gm_create_ticket(text, text, text, text, text, text, text) TO authenticated, service_role;");
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
    expect(migration).toMatch(/ROLLBACK SQL/);
    // List + status RPCs exist (super admin)
    expect(migration).toContain('gm_list_tickets');
    expect(migration).toContain('gm_update_ticket_status');

    // Service-role fix migration guarantees gm_list_tickets and gm_update_ticket_status allow service role
    const fixMigration = read('supabase/migrations/20260824122000_fix_tickets_service_role_rpc.sql');
    expect(fixMigration).toMatch(/WHERE \(auth\.uid\(\) IS NULL OR public\.is_super_admin\(\)\)/);
    expect(fixMigration).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN[\s\S]*?IF NOT public\.is_super_admin\(\)/);
    expect(fixMigration).toContain("GRANT EXECUTE ON FUNCTION public.gm_list_tickets() TO authenticated, service_role;");
    expect(fixMigration).toContain("GRANT EXECUTE ON FUNCTION public.gm_update_ticket_status(bigint, text) TO authenticated, service_role;");
  });

  it('the tickets Edge Function enforces identity + the 3-role gate and is CORS-correct', () => {
    const edge = read('supabase/functions/tickets/index.ts');
    expect(edge).toContain('validateCallerAuth');
    expect(edge).toContain('ADMIN_ROLES.includes(caller.role)');
    expect(edge).toContain('forbidden');
    expect(edge).toContain('makeJson(req)');
    expect(edge).toContain('getCorsHeaders(req)');
    // The central webhook URL comes from a secret, never hardcoded/committed
    expect(edge).toContain('Deno.env.get("TICKET_WEBHOOK_URL")');
    // Webhook dispatch goes through the SSRF-safe proxy, not a direct fetch
    expect(edge).toContain('discord-webhook-proxy');
  });

  it('config.toml registers tickets as JWT-gated', () => {
    const toml = read('supabase/config.toml');
    expect(toml).toMatch(/\[functions\.tickets\]\s*verify_jwt = true/);
  });

  it('the topbar Report-a-bug button is gated by isGuildAdmin (all 3 admin roles, member excluded)', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    expect(shell).toContain('data-gm-report-bug');
    expect(shell).toContain('isGuildAdmin()');
    expect(shell).toContain('openBugReportModal');
    // A super-admin Tickets nav item exists
    expect(shell).toContain("id: 'tickets'");
  });

  it('the desktop sidebar also renders the Report-a-bug button (topbar is hidden >= 901px)', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    const sidebar = shell.slice(shell.indexOf('public renderSidebar(): void'), shell.indexOf('public renderTopbar(): void'));
    expect(sidebar).toContain('gm-sidebar-report-bug');
    expect(sidebar).toContain("(canReportBug");
    expect(sidebar).toContain('openBugReportModal');
    const css = read('shell.css');
    // The topbar is hidden on desktop, confirming the sidebar button is required
    expect(css).toMatch(/@media \(min-width: 901px\)[\s\S]*?\.gm-topbar \{[\s\S]*?display: none/);
  });

  it('isGuildAdmin() covers guild_admin, server_admin and super_admin (and excludes member)', () => {
    const utils = read('gm-utils.js');
    const fnStart = utils.indexOf('function isGuildAdmin()');
    const fn = utils.slice(fnStart, utils.indexOf('\n    }', fnStart) + 6);
    expect(fn).toContain("r === 'guild_admin' || r === 'server_admin' || r === 'super_admin'");
    expect(fn).not.toContain("'member'");
  });

  it('tickets are submitted through the tickets Edge Function and escape output', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    expect(shell).toContain("functions.invoke('tickets'");
    const modalStart = shell.indexOf('public openBugReportModal(): void');
    const modal = shell.slice(modalStart, modalStart + 20000);
    expect(modal).toContain('gm-modal-overlay');
    expect(modal).toContain('bug-report-submit');
    expect(modal).toContain('ticket-current-behavior');
    expect(modal).toContain('ticket-expected-behavior');
    expect(modal).toContain('ticket-steps');
    expect(modal).toContain('ticket-additional-context');
  });

  it('detectClientEnvironment and formatTicketDescription format the structured schema correctly', () => {
    const env = window.GM.detectClientEnvironment('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    // macOS/iOS deliberately report just the platform name, no version: every
    // browser freezes the "Mac OS X 10_15_7" UA token at that exact value
    // regardless of the real installed macOS version (confirmed live on
    // macOS 26.6.2 still reporting 10_15_7) — showing it as real would be
    // actively misleading, not just imprecise.
    expect(env.os).toBe('macOS');
    expect(env.browser).toContain('Chrome 128');
    expect(env.appVersion).toBeDefined();

    const winEnv = window.GM.detectClientEnvironment('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0');
    expect(winEnv.os).toBe('Windows 10/11');
    expect(winEnv.browser).toContain('Edge 127');

    const iosEnv = window.GM.detectClientEnvironment('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    // Same freeze applies to iOS's "OS X_Y" token (confirmed live: a real
    // iOS 26.6.1 device still reports 18_7 here) — no version shown.
    expect(iosEnv.os).toBe('iOS');
    // Safari's marketing version now matches the OS's yearly number (Safari
    // 26 ships with iOS/macOS 26); only the major version of the "Version/"
    // UA token is shown, matching every other browser branch's convention.
    expect(iosEnv.browser).toBe('Safari 17');

    const desc = window.GM.formatTicketDescription({
      currentBehavior: 'Something broke',
      expectedBehavior: 'It should work',
      steps: '1. Click A\n2. Click B',
      additionalContext: 'Error 500 in console',
      env: env
    });

    expect(desc).toContain('**Current Behavior / Issue**\nSomething broke');
    expect(desc).toContain('**Expected Behavior**\nIt should work');
    expect(desc).toContain('**Steps to Reproduce**\n1. Click A\n2. Click B');
    expect(desc).toContain('**Additional Context / Information**\nError 500 in console');
    expect(desc).toContain('**Environment**');
    expect(desc).toContain('• FGF Mgmt Tool Version:');
    expect(desc).toContain('• OS + Version: macOS');
    expect(desc).toContain('• Browser + Version: Chrome 128');
  });

  it('the super-admin tickets console lists, updates statuses, and displays screenshot thumbnails', () => {
    const tickets = read('tickets.js');
    expect(tickets).toContain('window.GM_TICKETS');
    expect(tickets).toContain("action: 'list'");
    expect(tickets).toContain("action: 'update-status'");
    expect(tickets).toContain('gm-ticket-status');
    expect(tickets).toContain('gm-ticket-thumb');
    expect(tickets).toContain('openLightbox');
    expect(tickets).toContain('esc(');
  });

  it('supports screenshot attachments across migration, modal dropzone, and edge function', () => {
    const migration = read('supabase/migrations/20260824123500_tickets_attachments.sql');
    expect(migration).toContain('ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS attachments JSONB');
    expect(migration).toContain('p_attachments jsonb');

    const shell = read('src/modules/shell/views/ShellView.ts');
    expect(shell).toContain('ticket-dropzone');
    expect(shell).toContain('ticket-file-input');
    expect(shell).toContain('ticket-screenshots-preview');
    expect(shell).toContain('attachedScreenshots');
    expect(shell).toContain('onPaste');

    const edge = read('supabase/functions/tickets/index.ts');
    expect(edge).toContain('dataUrlToBytes');
    expect(edge).toContain('p_attachments: attachments');
    expect(edge).toContain('payload_json');

    expect(typeof window.GM.compressImageForUpload).toBe('function');
  });

  it('supports 4 ticket statuses and sends Discord status updates', () => {
    const migration = read('supabase/migrations/20260824124500_ticket_statuses.sql');
    expect(migration).toContain("ALTER TABLE public.tickets ALTER COLUMN status SET DEFAULT 'waiting'");
    expect(migration).toContain("'waiting'");
    expect(migration).toContain("'in_progress'");

    const tickets = read('tickets.js');
    expect(tickets).toContain('tickets_status_waiting');
    expect(tickets).toContain('tickets_status_in_progress');
    expect(tickets).toContain('tickets_status_resolved');
    expect(tickets).toContain('tickets_status_closed');
    expect(tickets).toContain('curStatus === \'in_progress\'');

    const edge = read('supabase/functions/tickets/index.ts');
    expect(edge).toContain('STATUS_META');
    expect(edge).toContain('Ticket Status: #TICKET-');
    expect(edge).toContain('TICKET_STATUS_WEBHOOK_URL');
  });

  it('i18n exposes the ticket strings including screenshots and statuses', () => {
    const i18n = read('i18n.js');
    expect(i18n).toContain('gm_nav_tickets:');
    expect(i18n).toContain("ticket_report_bug:");
    expect(i18n).toContain('ticket_submit:');
    expect(i18n).toContain('ticket_current_behavior:');
    expect(i18n).toContain('ticket_expected_behavior:');
    expect(i18n).toContain('ticket_steps:');
    expect(i18n).toContain('ticket_additional_context:');
    expect(i18n).toContain('ticket_screenshots_title:');
    expect(i18n).toContain('ticket_screenshots_hint:');
    expect(i18n).toContain('ticket_screenshots_max_err:');
    expect(i18n).toContain('ticket_env_title:');
    expect(i18n).toContain('tickets_status_waiting:');
    expect(i18n).toContain('tickets_status_in_progress:');
  });
});
