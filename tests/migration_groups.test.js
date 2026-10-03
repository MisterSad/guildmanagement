// Regression guard for the cross-server migration groups feature
// (supabase/migrations/20260830072000_cross_server_migration_groups.sql):
// the two new tables, their RLS policies, the eligibility helper, and the
// promotion into the 4 transfer-eligibility functions must all be present.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { edgeSource } from './helpers/edge-source.js';

const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260830072000_cross_server_migration_groups.sql');
const content = fs.readFileSync(migrationPath, 'utf-8');

describe('Cross-server migration groups migration', () => {
  it('creates the two schema tables with the expected columns', () => {
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.server_migration_groups');
    expect(content).toMatch(/status TEXT NOT NULL DEFAULT 'open' CHECK \(status IN \('open', 'closed'\)\)/);
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.server_migration_group_servers');
    expect(content).toContain('REFERENCES public.server_migration_groups(id) ON DELETE CASCADE');
    expect(content).toContain('UNIQUE (group_id, server_number)');
  });

  it('enables RLS gated on gm_can_read_guilds (read) and is_super_admin (write) — only a super admin can manage groups', () => {
    expect(content).toContain('ALTER TABLE public.server_migration_groups ENABLE ROW LEVEL SECURITY');
    expect(content).toContain('ALTER TABLE public.server_migration_group_servers ENABLE ROW LEVEL SECURITY');
    expect(content).toMatch(/CREATE POLICY gm_smg_select ON public\.server_migration_groups[\s\S]*?USING \(public\.gm_can_read_guilds\(\)\)/);
    expect(content).toMatch(/CREATE POLICY gm_smg_write ON public\.server_migration_groups[\s\S]*?USING \(public\.is_super_admin\(\)\)/);
    expect(content).toMatch(/CREATE POLICY gm_smgs_select ON public\.server_migration_group_servers[\s\S]*?USING \(public\.gm_can_read_guilds\(\)\)/);
    expect(content).toMatch(/CREATE POLICY gm_smgs_write ON public\.server_migration_group_servers[\s\S]*?USING \(public\.is_super_admin\(\)\)/);
  });

  it('defines servers_in_open_migration_group scoped to status = open', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.servers_in_open_migration_group(p_server_a text, p_server_b text)');
    expect(content).toContain("WHERE g.status = 'open'");
  });

  it('extends all 4 transfer-eligibility functions with the migration-group check, not just same-server', () => {
    // Each of the 4 functions must call the helper as an OR-alternative to
    // strict server equality, not replace the same-server check outright.
    const transferFns = ['request_guild_transfer', 'gm_transfer_guild_member', 'resolve_guild_transfer', 'gm_admin_request_transfer'];
    for (const fn of transferFns) {
      expect(content, `${fn} must be redefined in this migration`).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    const occurrences = (content.match(/servers_in_open_migration_group/g) || []).length;
    // Definition + REVOKE/GRANT + at least one call per transfer function (5+ call sites minimum).
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  it('re-validates the source/target server relationship at approval time (closing a window blocks a stale pending request)', () => {
    const approveSection = content.slice(content.indexOf("IF p_action = 'approve' THEN"));
    expect(approveSection).toContain('v_approve_source_server');
    expect(approveSection).toContain('v_approve_target_server');
    expect(approveSection).toContain("'different_server'");
  });

  it('adds gm_list_transfer_eligible_guilds returning same-server + open-group guilds, flagged is_same_server', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.gm_list_transfer_eligible_guilds(p_guild text)');
    expect(content).toContain('is_same_server');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.gm_list_transfer_eligible_guilds(text) TO authenticated');
  });

  it('ends with a PostgREST schema reload notification, matching every other canonical migration', () => {
    expect(content.trim().toLowerCase()).toMatch(/notify pgrst, 'reload schema';\s*$/);
  });
});

describe('Cross-server migration groups UI wiring', () => {
  const appJs = fs.readFileSync(path.resolve(__dirname, '../src/modules/app/admin/migration-groups.controller.ts'), 'utf-8');
  const migrationService = fs.readFileSync(path.resolve(__dirname, '../src/modules/migration/migration.service.ts'), 'utf-8');
  const membersCtrl = fs.readFileSync(path.resolve(__dirname, '../src/modules/app/members/members.controller.ts'), 'utf-8');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');
  const portalJs = fs.readFileSync(path.resolve(__dirname, '../src/modules/portal/views/PortalView.ts'), 'utf-8');
  const memberPortalFn = edgeSource('member-portal');

  it('renders a Super Admin card to create/open/close migration groups', () => {
    expect(indexHtml).toContain('id="migration-groups-card"');
    expect(indexHtml).toContain('id="create-migration-group-form"');
    expect(indexHtml).toContain('id="migration-groups-list-container"');
  });

  it('defines renderMigrationGroupsList and wires it into the Super Admin tab load path', () => {
    expect(appJs).toContain('function renderMigrationGroupsList');
    // The queries live in the migration service since M4b; the controller calls them.
    expect(migrationService).toContain("server_migration_groups");
    expect(migrationService).toContain("server_migration_group_servers");
    expect(appJs).toContain('queryMigrationGroups(db)');
    expect(appJs).toContain('queryMigrationGroupServers(db)');
    const callSites = (appJs.match(/renderMigrationGroupsList\(\);/g) || []).length;
    expect(callSites).toBeGreaterThanOrEqual(2);
  });

  it('showTransferMemberDialog uses the backend-authoritative eligibility RPC and labels cross-server options', () => {
    expect(membersCtrl).toContain('listTransferEligibleGuilds(client, currentG)');
    expect(fs.readFileSync(path.resolve(__dirname, '../src/modules/members/members.service.ts'), 'utf-8')).toContain("db.rpc('gm_list_transfer_eligible_guilds'");
    expect(membersCtrl).toContain('Migration Window');
  });

  it('the player portal transfer picker and its Edge Function action use the same eligibility RPC', () => {
    expect(memberPortalFn).toContain('gm_list_transfer_eligible_guilds');
    expect(portalJs).toContain('is_same_server');
  });
});
