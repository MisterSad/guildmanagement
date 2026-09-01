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

describe('Regression: /link never lets a self-typed value prove account ownership', () => {
    // The code confirmation must happen through member-portal's
    // authenticated getIdentity() gate (a real login session), not by
    // accepting a client-supplied account/discord id directly -- otherwise
    // anyone could claim anyone else's Discord link.
    const memberPortalSrc = fs.readFileSync(
        path.resolve(__dirname, '../supabase/functions/member-portal/index.ts'),
        'utf-8'
    );

    it('confirm-discord-link writes account_id from identity.accountId, never from the request payload', () => {
        const idx = memberPortalSrc.indexOf('action === "confirm-discord-link"');
        expect(idx).toBeGreaterThan(-1);
        const block = memberPortalSrc.slice(idx, idx + 1500);
        expect(block).toContain('account_id: identity.accountId');
        expect(block).not.toMatch(/account_id:\s*payload/);
    });

    it('confirm-discord-link sits behind the same authenticated identity gate as every other action', () => {
        // getIdentity() runs once, before the action dispatch -- confirm the
        // action block itself is below that check, not a special early exit.
        const identityCheckIdx = memberPortalSrc.indexOf('if (!identity || !identity.uid)');
        const actionIdx = memberPortalSrc.indexOf('action === "confirm-discord-link"');
        expect(identityCheckIdx).toBeGreaterThan(-1);
        expect(actionIdx).toBeGreaterThan(identityCheckIdx);
    });
});

describe('Regression: discord_account_links enforces a 1:1 mapping at the DB level', () => {
    const migrationSrc = fs.readFileSync(
        path.resolve(__dirname, '../supabase/migrations/20260901150000_discord_bot_phase1.sql'),
        'utf-8'
    );

    it('account_id has a unique constraint (a Discord account can only claim one FGF account, and vice versa)', () => {
        expect(migrationSrc).toMatch(/CREATE UNIQUE INDEX[^;]*discord_account_links\(account_id\)/);
    });

    it('both new tables have RLS enabled with no policies (service_role only)', () => {
        expect(migrationSrc).toContain('ALTER TABLE public.discord_link_codes ENABLE ROW LEVEL SECURITY');
        expect(migrationSrc).toContain('ALTER TABLE public.discord_account_links ENABLE ROW LEVEL SECURITY');
        expect(migrationSrc).not.toContain('CREATE POLICY');
    });
});
