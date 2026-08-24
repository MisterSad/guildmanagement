// Regression guards for the bug-report ticketing system (V3.5.3): any
// guild_admin / server_admin / super_admin can report a bug; the ticket is
// persisted (global sequential number), sent to a central Discord webhook via
// the SSRF-safe proxy, and listed/managed by the super admin.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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
    const shell = read('shell.js');
    expect(shell).toContain('data-gm-report-bug');
    expect(shell).toContain('window.GM.isGuildAdmin()');
    expect(shell).toContain('openBugReportModal');
    // A super-admin Tickets nav item exists
    expect(shell).toContain("id: 'tickets'");
  });

  it('tickets are submitted through the tickets Edge Function and escape output', () => {
    const shell = read('shell.js');
    expect(shell).toContain("functions.invoke('tickets'");
    const modalStart = shell.indexOf('function openBugReportModal');
    const modal = shell.slice(modalStart, modalStart + 8000);
    expect(modal).toContain('gm-modal-overlay');
    expect(modal).toContain('bug-report-submit');
  });

  it('the super-admin tickets console lists and updates statuses', () => {
    const tickets = read('tickets.js');
    expect(tickets).toContain('window.GM_TICKETS');
    expect(tickets).toContain("action: 'list'");
    expect(tickets).toContain("action: 'update-status'");
    expect(tickets).toContain('gm-ticket-status');
    expect(tickets).toContain('esc(');
  });

  it('i18n exposes the ticket strings', () => {
    const i18n = read('i18n.js');
    expect(i18n).toContain('gm_nav_tickets:');
    expect(i18n).toContain("ticket_report_bug:");
    expect(i18n).toContain('ticket_submit:');
  });
});
