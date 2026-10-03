// Discord bot integration, Phase 1: verifyDiscordSignature is a plain
// function (crypto.subtle + TextEncoder only, no Deno-specific globals at
// call time) so it's testable directly here, against real Ed25519 test
// vectors -- not just re-derived reasoning about what "should" work.
// Confirmed live once already (this exact runtime, this exact project)
// before any of Phase 1 was built on top of it; this test guards the
// pure verification logic from regressing independently of that.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { webcrypto } from 'crypto';
import { verifyDiscordSignature } from '../supabase/functions/_shared/discord.ts';
import { edgeSource } from './helpers/edge-source.js';

function toHex(bytes) {
    return Buffer.from(bytes).toString('hex');
}

describe('verifyDiscordSignature (Ed25519)', () => {
    it('accepts a genuine signature over timestamp + body', async () => {
        const kp = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        const pubRaw = await webcrypto.subtle.exportKey('raw', kp.publicKey);
        const pubHex = toHex(pubRaw);

        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({ type: 1 });
        const message = Buffer.from(timestamp + body, 'utf8');
        const sig = await webcrypto.subtle.sign('Ed25519', kp.privateKey, message);

        const valid = await verifyDiscordSignature(pubHex, toHex(sig), timestamp, body);
        expect(valid).toBe(true);
    });

    it('rejects a forged/garbage signature', async () => {
        const kp = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        const pubRaw = await webcrypto.subtle.exportKey('raw', kp.publicKey);
        const pubHex = toHex(pubRaw);

        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({ type: 1 });
        const fakeSig = '00'.repeat(64);

        const valid = await verifyDiscordSignature(pubHex, fakeSig, timestamp, body);
        expect(valid).toBe(false);
    });

    it('rejects a genuine signature applied to a tampered body', async () => {
        const kp = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        const pubRaw = await webcrypto.subtle.exportKey('raw', kp.publicKey);
        const pubHex = toHex(pubRaw);

        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({ type: 1 });
        const sig = await webcrypto.subtle.sign('Ed25519', kp.privateKey, Buffer.from(timestamp + body, 'utf8'));

        const tamperedBody = JSON.stringify({ type: 2 });
        const valid = await verifyDiscordSignature(pubHex, toHex(sig), timestamp, tamperedBody);
        expect(valid).toBe(false);
    });
});

describe('Regression: nothing outside the guarded RPCs writes discord_account_links', () => {
    // /link + member-portal `confirm-discord-link` used to insert a link
    // directly: the password survived, the claim then refused the account for
    // good, and a Discord identity could attach a second account without the
    // admin relink code. Both were removed on 2026-10-03. A link is now created
    // only by the SECURITY DEFINER RPCs behind auth-discord.
    const memberPortalSrc = edgeSource('member-portal');
    const workerSrc = fs.readFileSync(
        path.resolve(__dirname, '../discord-verification-worker/index.js'),
        'utf-8'
    );
    const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it('member-portal no longer has a confirm-discord-link action', () => {
        expect(strip(memberPortalSrc)).not.toContain('confirm-discord-link');
        expect(memberPortalSrc).not.toMatch(/from\("discord_account_links"\)\s*\.insert/);
    });

    it('the worker never inserts a link or mints a link code', () => {
        expect(workerSrc).not.toMatch(/from\("discord_account_links"\)\s*\.insert/);
        expect(workerSrc).not.toContain('discord_link_codes');
    });
});

describe('Regression: discord_account_links enforces a 1:1 mapping at the DB level', () => {
    const migrationSrc = fs.readFileSync(
        path.resolve(__dirname, '../supabase/migrations/20260901150000_discord_bot_phase1.sql'),
        'utf-8'
    );

    it('account_id has a unique constraint (an FGF account belongs to at most one Discord identity)', () => {
        expect(migrationSrc).toMatch(/CREATE UNIQUE INDEX[^;]*discord_account_links\(account_id\)/);
    });

    it('both new tables have RLS enabled with no policies (service_role only)', () => {
        expect(migrationSrc).toContain('ALTER TABLE public.discord_link_codes ENABLE ROW LEVEL SECURITY');
        expect(migrationSrc).toContain('ALTER TABLE public.discord_account_links ENABLE ROW LEVEL SECURITY');
        expect(migrationSrc).not.toContain('CREATE POLICY');
    });
});
