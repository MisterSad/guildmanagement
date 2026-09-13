import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Guild Requests admin panel: discord_handle/note must always be HTML-escaped', () => {
    // guild_creation_requests.discord_handle and .note are the first fully
    // anonymous, unauthenticated free-text fields ever rendered into a
    // privileged admin view in this app (submitted via the public
    // guild-request Edge Function, no login required). A future edit that
    // interpolates them without esc() would be a stored-XSS hole reachable
    // by anyone, no account needed.
    // Ported to /src in the Strangler cutover (was app.js).
    const src = fs.readFileSync(path.resolve(__dirname, '../src/modules/app/admin/guild-requests.controller.ts'), 'utf-8');

    it('wraps r.note in esc() before interpolating into markup', () => {
        expect(src).toMatch(/esc\(r\.note\)/);
        expect(src).not.toMatch(/\+\s*r\.note\s*\+/);
    });

    it('wraps r.discord_handle in esc() before interpolating into markup', () => {
        expect(src).toMatch(/esc\(r\.discord_handle\)/);
        expect(src).not.toMatch(/\+\s*r\.discord_handle\s*\+/);
    });

    it('wraps r.guild_tag and r.admin_id in esc() too', () => {
        expect(src).toMatch(/esc\(r\.guild_tag\)/);
        expect(src).toMatch(/esc\(r\.admin_id\)/);
    });
});

describe('Guild Requests: eligible-leaders-style RPC usage for approve/reject', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/modules/app/admin/guild-requests.controller.ts'), 'utf-8');

    it('approve/reject guild requests go through the admin-accounts edge function, not a raw table write', () => {
        expect(src).toMatch(/adminAccounts\(['"]approve-guild-request['"]/);
        expect(src).toMatch(/adminAccounts\(['"]reject-guild-request['"]/);
        expect(src).not.toMatch(/from\(['"]guild_creation_requests['"]\)\.update/);
    });

    it('clear-history button goes through admin-accounts too, and asks for confirmation first', () => {
        expect(src).toMatch(/adminAccounts\(['"]clear-resolved-guild-requests['"]/);
        expect(src).toMatch(/showConfirm\(\s*['"]Clear Guild Request History['"][\s\S]{0,400}clear-resolved-guild-requests/);
    });
});

describe('Guild Requests: clearing history never touches pending requests', () => {
    // The whole point of "Clear History" is to sweep away resolved rows an
    // admin no longer needs to see -- it must never be able to silently
    // delete a request someone hasn't reviewed yet.
    const src = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/admin-accounts/index.ts'), 'utf-8');

    it('clear-resolved-guild-requests is gated to super_admin and filters out pending rows', () => {
        const idx = src.indexOf('"clear-resolved-guild-requests"');
        expect(idx).toBeGreaterThan(-1);
        const block = src.slice(idx, idx + 800);
        expect(block).toContain('info.role !== "super_admin"');
        expect(block).toMatch(/\.neq\(\s*["']status["'],\s*["']pending["']\s*\)/);
    });
});
