import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Security Hardening & Module Audits', () => {
    it('verifies admin-accounts index.ts contains strict role guards', () => {
        const filePath = path.resolve(__dirname, '../supabase/functions/admin-accounts/index.ts');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('if (!info.role || (info.role !== "guild_admin" && info.role !== "super_admin"))');
        expect(content).not.toContain('action === "get-password"');
        expect(content).toContain('action === "reset-password"');
    });

    it('verifies event-reminders index.ts contains isValidDiscordWebhook SSRF check', () => {
        const filePath = path.resolve(__dirname, '../supabase/functions/event-reminders/index.ts');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('function isValidDiscordWebhook');
        expect(content).toContain('SECURITY: Invalid or untrusted Discord Webhook URL blocked');
    });

    it('verifies player-register index.ts extracts client IP safely', () => {
        const filePath = path.resolve(__dirname, '../supabase/functions/player-register/index.ts');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('cf-connecting-ip');
        expect(content).toContain('x-real-ip');
    });

    it('verifies history.js contains ALLOWED_HISTORY_FIELDS whitelist', () => {
        const filePath = path.resolve(__dirname, '../history.js');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('ALLOWED_HISTORY_FIELDS');
        expect(content).toContain('Unauthorized field update attempt');
    });

    it('verifies shadowfront.js calls atomic gm_unsync_shadowfront_participant RPC', () => {
        const filePath = path.resolve(__dirname, '../shadowfront.js');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('gm_unsync_shadowfront_participant');
    });

    it('verifies vercel.json contains CSP headers', () => {
        const filePath = path.resolve(__dirname, '../vercel.json');
        const content = fs.readFileSync(filePath, 'utf-8');
        const json = JSON.parse(content);
        expect(json.headers[0].headers.some(h => h.key === 'Content-Security-Policy')).toBe(true);
    });

    it('verifies gm_reset_account_password migration uses valid column password_enc and pgp_sym_encrypt', () => {
        const filePath = path.resolve(__dirname, '../supabase/migrations/20260810210000_fix_reset_account_password.sql');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('password_enc = extensions.pgp_sym_encrypt');
        expect(content).not.toContain('password_encrypted');
        expect(content).not.toContain('pgtap_encrypt');
        expect(content).not.toContain('updated_at = now()');
    });
});
