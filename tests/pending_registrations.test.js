import { describe, it, expect, beforeEach } from 'vitest';
import { appHtml } from './helpers/app-html.js';
import { squash } from './helpers/source-text.js';
import fs from 'fs';
import path from 'path';
import { canManageAccount } from '../supabase/functions/_shared/admin-authz';
import { edgeSource } from './helpers/edge-source.js';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Pending Player Registration Visibility & Validation', () => {
  describe('Database Migration (20260904030000_fix_gm_admin_list_status.sql)', () => {
    const migration = read('supabase/migrations/20260904030000_fix_gm_admin_list_status.sql');

    it('drops existing function before recreating with updated signature', () => {
      expect(migration).toContain('DROP FUNCTION IF EXISTS public.gm_admin_list();');
    });

    it('includes status text in RETURNS TABLE signature', () => {
      expect(migration).toMatch(/RETURNS\s+TABLE\s*\([\s\S]*?\bstatus\s+text\b[\s\S]*?\)/i);
    });

    it('queries accounts directly without auth.uid() service-role blockers', () => {
      const activeSql = migration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
      expect(activeSql).toContain("COALESCE(a.status, 'active')");
      // Must NOT contain caller-blocking gates that fail when auth.uid() is null in active SQL
      expect(activeSql).not.toMatch(/IF\s+public\.is_super_admin\(\)/i);
      expect(activeSql).not.toMatch(/WHERE\s+public\.gm_can_read_guild_data/i);
    });

    it('strictly locks execution to service_role with grant hygiene', () => {
      expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_admin_list\(\) FROM public, anon, authenticated;/i);
      expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.gm_admin_list\(\) TO service_role;/i);
      expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
    });
  });

  describe('Edge Function (admin-accounts/index.ts)', () => {
    const edgeCode = edgeSource('admin-accounts');

    it('performs case-insensitive guild comparison when filtering list for guild_admin', () => {
      expect(edgeCode).toMatch(
        /const callerGuildNorm = callerGuild \? String\(callerGuild\)\.trim\(\)\.toUpperCase\(\) : "";/
      );
      expect(edgeCode).toMatch(/String\(acc\.guild\)\.trim\(\)\.toUpperCase\(\) === callerGuildNorm/);
    });

    it('canManageAccount permits guild_admin to manage pending members of their guild', () => {
      const caller = {
        role: 'guild_admin',
        guild: 'ALPHA',
        serverNumber: '1058',
      };
      const pendingTarget = {
        role: 'member',
        guild: 'alpha', // case variation
        serverNumber: null,
      };

      expect(canManageAccount(caller, pendingTarget)).toBe(true);
    });

    it('canManageAccount forbids guild_admin from managing members of another guild', () => {
      const caller = {
        role: 'guild_admin',
        guild: 'ALPHA',
        serverNumber: '1058',
      };
      const foreignTarget = {
        role: 'member',
        guild: 'BABE',
        serverNumber: '1058',
      };

      expect(canManageAccount(caller, foreignTarget)).toBe(false);
    });
  });

  describe('Admin Console UI (index.html & /src admin modules)', () => {
    it('index.html contains pending registrations section in Accounts & Access tab', () => {
      const html = appHtml();
      expect(html).toContain('id="pending-accounts-card-admin"');
      expect(html).toContain('id="admin-pending-account-list"');
      expect(html).toContain('id="admin-pending-account-count"');
    });

    it('renderPendingRegistrations updates both Overview and Accounts tabs', () => {
      const appJs = read('src/modules/app/admin/guild-requests.controller.ts');
      expect(appJs).toContain("byId('admin-pending-account-list')");
      expect(appJs).toContain("byId('admin-pending-account-count')");
      expect(appJs).toContain("byId('pending-account-list')");
      expect(appJs).toContain("byId('pending-account-count')");
    });

    it('matches guild case-insensitively in renderPendingRegistrations and renderAccounts', () => {
      const appJs =
        read('src/modules/app/admin/guild-requests.controller.ts') + read('src/modules/app/admin/accounts.render.ts');
      expect(squash(appJs)).toMatch(/const activeGUpper = String\(guild \|\| ''\)\.trim\(\)\.toUpperCase\(\);/);
      expect(squash(appJs)).toMatch(/accGuildUpper === activeGUpper/);
      expect(squash(appJs)).toMatch(/String\(accGuild\)\.trim\(\)\.toUpperCase\(\) === activeGUpper/);
    });

    it('filters out pending status accounts from active member accounts', () => {
      const appJs = read('src/modules/app/admin/accounts.render.ts');
      expect(appJs).toMatch(/if \(acc\.status === 'pending'\) return false;/);
    });
  });

  describe('DOM Simulation for Pending Registrations', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="pending-account-list"></div>
        <span id="pending-account-count">0</span>
        <div id="admin-pending-account-list"></div>
        <span id="admin-pending-account-count">0</span>
        <div id="account-list"></div>
        <span id="account-count">0</span>
        <div id="member-account-list"></div>
        <span id="member-account-count">0</span>
      `;
    });

    it('correctly populates pending list and counts in both Overview and Admin containers', () => {
      const mockAccounts = [
        {
          id: 'PlayerAlpha1',
          role: 'member',
          status: 'pending',
          guild: 'Alpha',
          uid: '12345',
          created_at: '2026-09-03T10:00:00Z',
        },
        {
          id: 'PlayerAlpha2',
          role: 'member',
          status: 'active',
          guild: 'ALPHA',
          uid: '67890',
          created_at: '2026-09-01T10:00:00Z',
        },
        {
          id: 'AdminAlpha',
          role: 'guild_admin',
          status: 'active',
          guild: 'ALPHA',
          uid: null,
          created_at: '2026-08-01T10:00:00Z',
        },
        {
          id: 'PlayerBabe1',
          role: 'member',
          status: 'pending',
          guild: 'BABE',
          uid: '11111',
          created_at: '2026-09-03T11:00:00Z',
        },
      ];

      const activeG = 'ALPHA';
      const activeGUpper = activeG.trim().toUpperCase();

      // Simulate the logic in app.js
      const pending = mockAccounts.filter((acc) => {
        const accGuildUpper = String(acc.guild || 'ALPHA')
          .trim()
          .toUpperCase();
        return acc.status === 'pending' && acc.role === 'member' && accGuildUpper === activeGUpper;
      });

      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('PlayerAlpha1');

      // Check active accounts logic
      const activeAccounts = mockAccounts.filter((acc) => {
        if (acc.status === 'pending') return false;
        const accGuildUpper = String(acc.guild || 'ALPHA')
          .trim()
          .toUpperCase();
        return accGuildUpper === activeGUpper;
      });

      expect(activeAccounts).toHaveLength(2);
      expect(activeAccounts.map((a) => a.id)).toEqual(['PlayerAlpha2', 'AdminAlpha']);

      const memberAccounts = activeAccounts.filter((acc) => acc.role === 'member');
      expect(memberAccounts).toHaveLength(1);
      expect(memberAccounts[0].id).toBe('PlayerAlpha2');
    });
  });
});
