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
    const src = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf-8');

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
    const src = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf-8');

    it('approve/reject guild requests go through the admin-accounts edge function, not a raw table write', () => {
        expect(src).toContain("window.GM.adminAccounts('approve-guild-request'");
        expect(src).toContain("window.GM.adminAccounts('reject-guild-request'");
        expect(src).not.toMatch(/from\(['"]guild_creation_requests['"]\)\.update/);
    });
});
