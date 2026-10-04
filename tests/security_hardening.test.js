import { describe, it, expect, } from 'vitest';
import fs from 'fs';
import path from 'path';
import { edgeSource } from './helpers/edge-source.js';

describe('Security Hardening & Module Audits', () => {
    it('verifies admin-accounts index.ts contains strict role guards', () => {
        const content = edgeSource('admin-accounts');
        expect(content).toContain('if (!info.role || !isAdminRole(info.role))');
        expect(content).not.toContain('"get-password"');
        expect(content).toContain('"reset-password": resetPassword,');
        expect(content).toContain('"update-role": updateRole,');
    });

    it('verifies event-reminders index.ts contains isValidDiscordWebhook SSRF check and zero raw console calls', () => {
        const content = edgeSource('event-reminders');
        expect(content).toContain('function isValidDiscordWebhook');
        expect(content).toContain('SECURITY: Invalid or untrusted Discord Webhook URL blocked');
        expect(content).toContain('new EdgeLogger');
        expect(content).not.toContain('console.log(');
        expect(content).not.toContain('console.warn(');
        expect(content).not.toContain('console.error(');
    });

    it('verifies player-register index.ts extracts client IP safely', () => {
        const filePath = path.resolve(__dirname, '../supabase/functions/player-register/index.ts');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('cf-connecting-ip');
        expect(content).toContain('x-real-ip');
    });

    it('verifies History whitelist ALLOWED_HISTORY_FIELDS + guarded update', () => {
        const service = fs.readFileSync(path.resolve(__dirname, '../src/modules/history/history.service.ts'), 'utf-8');
        expect(service).toContain('ALLOWED_HISTORY_FIELDS');
        const view = fs.readFileSync(path.resolve(__dirname, '../src/modules/history/views/HistoryView.ts'), 'utf-8');
        expect(view).toContain('ALLOWED_HISTORY_FIELDS');
        expect(view).toContain('Unauthorized field update attempt');
    });

    it('verifies ShadowfrontView calls atomic gm_unsync_shadowfront_participant RPC', () => {
        const filePath = path.resolve(__dirname, '../src/modules/shadowfront/views/ShadowfrontView.ts');
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
        const filePath = path.resolve(__dirname, '../supabase/migrations_archive/20260810210000_fix_reset_account_password.sql');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('password_enc = extensions.pgp_sym_encrypt');
        expect(content).not.toContain('password_encrypted');
        expect(content).not.toContain('pgtap_encrypt');
        expect(content).not.toContain('updated_at = now()');
    });
});
