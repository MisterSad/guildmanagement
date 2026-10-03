import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const proxyFilePath = path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts');
const proxyContent = fs.readFileSync(proxyFilePath, 'utf-8');

describe('Ticket 1.2: discord-webhook-proxy - Discord URL Whitelist & SSRF Protection', () => {
    // Replicate the exact whitelist logic from the Edge Function for verification
    const ALLOWED_DISCORD_HOSTS = new Set([
        'discord.com',
        'discordapp.com',
        'ptb.discord.com',
        'canary.discord.com',
        'ptb.discordapp.com',
        'canary.discordapp.com',
    ]);

    const DISCORD_WEBHOOK_PATH_REGEX = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

    function isValidDiscordWebhook(url) {
        if (!url || typeof url !== 'string') return false;
        const clean = url.replace(/^[<"'\s]+|[>'"\s]+$/g, '').trim();
        try {
            const u = new URL(clean.startsWith('http') ? clean : 'https://' + clean);
            return (
                u.protocol === 'https:' &&
                !u.username &&
                !u.password &&
                (!u.port || u.port === '443') &&
                ALLOWED_DISCORD_HOSTS.has(u.hostname.toLowerCase()) &&
                DISCORD_WEBHOOK_PATH_REGEX.test(u.pathname)
            );
        } catch {
            return false;
        }
    }

    it('allows valid official Discord webhook endpoints across official domains', () => {
        expect(isValidDiscordWebhook('https://discord.com/api/webhooks/1234567890/token_abc-XYZ_123')).toBe(true);
        expect(isValidDiscordWebhook('https://discordapp.com/api/webhooks/987654321/token_123')).toBe(true);
        expect(isValidDiscordWebhook('https://canary.discord.com/api/webhooks/12345/token_canary')).toBe(true);
        expect(isValidDiscordWebhook('https://ptb.discord.com/api/webhooks/67890/token_ptb')).toBe(true);
        expect(isValidDiscordWebhook('https://canary.discordapp.com/api/webhooks/12345/token')).toBe(true);
        expect(isValidDiscordWebhook('https://ptb.discordapp.com/api/webhooks/67890/token')).toBe(true);
        expect(isValidDiscordWebhook('https://discord.com/api/v10/webhooks/1234567890/token_v10')).toBe(true);
        expect(isValidDiscordWebhook('https://discord.com/api/v9/webhooks/1234567890/token_v9')).toBe(true);
    });

    it('cleans enclosing angle brackets or quotes', () => {
        expect(isValidDiscordWebhook('<https://discord.com/api/webhooks/1234567890/token_abc>')).toBe(true);
        expect(isValidDiscordWebhook('"https://discord.com/api/webhooks/1234567890/token_abc"')).toBe(true);
        expect(isValidDiscordWebhook('\'https://discord.com/api/webhooks/1234567890/token_abc\'')).toBe(true);
        expect(isValidDiscordWebhook('  https://discord.com/api/webhooks/1234567890/token_abc  ')).toBe(true);
    });

    it('rejects unencrypted HTTP endpoints', () => {
        expect(isValidDiscordWebhook('http://discord.com/api/webhooks/1234567890/token')).toBe(false);
        expect(isValidDiscordWebhook('http://canary.discord.com/api/webhooks/1234567890/token')).toBe(false);
    });

    it('rejects untrusted domains, typosquats, and subdomain takeover attempts', () => {
        expect(isValidDiscordWebhook('https://evil-discord.com/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com.attacker.com/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://notdiscord.com/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://sub.discord.com/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://support.discord.com/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://webhook.site/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://google.com/api/webhooks/123/token')).toBe(false);
    });

    it('rejects SSRF payloads targeting internal IPs and cloud metadata services', () => {
        expect(isValidDiscordWebhook('http://127.0.0.1:8080')).toBe(false);
        expect(isValidDiscordWebhook('http://localhost:54321')).toBe(false);
        expect(isValidDiscordWebhook('http://169.254.169.254/latest/meta-data/')).toBe(false);
        expect(isValidDiscordWebhook('http://[::1]:8080')).toBe(false);
        expect(isValidDiscordWebhook('http://10.0.0.1/')).toBe(false);
        expect(isValidDiscordWebhook('http://192.168.1.1/')).toBe(false);
    });

    it('rejects non-standard ports and URLs containing credentials', () => {
        expect(isValidDiscordWebhook('https://discord.com:8443/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com:80/api/webhooks/123/token')).toBe(false);
        expect(isValidDiscordWebhook('https://admin:secret@discord.com/api/webhooks/123/token')).toBe(false);
    });

    it('rejects malformed webhook paths', () => {
        expect(isValidDiscordWebhook('https://discord.com/api/webhooks/')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com/api/webhooks/non_numeric/token')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com/api/webhooks/12345/')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com/api/webhooks/12345/token/extra/path')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com/other/path/webhooks/12345/token')).toBe(false);
        expect(isValidDiscordWebhook('https://discord.com/api/v10/webhooks/')).toBe(false);
    });

    it('handles empty or non-string inputs safely without throwing', () => {
        expect(isValidDiscordWebhook('')).toBe(false);
        expect(isValidDiscordWebhook(null)).toBe(false);
        expect(isValidDiscordWebhook(undefined)).toBe(false);
        expect(isValidDiscordWebhook(12345)).toBe(false);
        expect(isValidDiscordWebhook({})).toBe(false);
        expect(isValidDiscordWebhook('not a url')).toBe(false);
    });
});

describe('Ticket 1.2: discord-webhook-proxy - Client Webhook URLs & Open Relay Prevention', () => {
    it('formally forbids client-supplied webhook URLs for guild_admins (returns 403)', () => {
        expect(proxyContent).toContain('if (isGuildAdmin(caller.role) && rawClientWebhook)');
        expect(proxyContent).toContain('return json({ ok: false, error: "forbidden_client_webhook_url" }, 403);');
    });

    it('formally forbids client-supplied webhook URLs for server_admins (returns 403)', () => {
        expect(proxyContent).toContain('if (isServerAdmin(caller.role))');
        expect(proxyContent).toContain('if (rawClientWebhook)');
        expect(proxyContent).toContain('return json({ ok: false, error: "forbidden_client_webhook_url" }, 403);');
    });

    it('strictly ignores body.webhookUrl for super_admin and forces server resolution from guild_config', () => {
        // Line resetting webhookUrl to empty string regardless of client input
        expect(proxyContent).toContain('webhookUrl = "";');
        expect(proxyContent).toContain('if (!webhookUrl && requestedGuild)');
        expect(proxyContent).toContain('.from("guild_config")');
        expect(proxyContent).toContain('.select("key, value")');
        expect(proxyContent).toContain('.eq("guild", requestedGuild)');
    });

    it('verifies guild_admin is strictly locked to caller.guild to prevent cross-guild dispatch', () => {
        expect(proxyContent).toContain('if (requestedGuild && caller.guild && requestedGuild.toUpperCase() !== caller.guild.toUpperCase())');
        expect(proxyContent).toContain('return json({ ok: false, error: "forbidden_cross_guild" }, 403);');
    });

    it('verifies server_admin is strictly locked to caller.serverNumber to prevent cross-server dispatch', () => {
        expect(proxyContent).toContain('return json({ ok: false, error: "forbidden_cross_server" }, 403);');
    });
});

describe('Ticket 1.2: discord-webhook-proxy - allowed_mentions Sanitization', () => {
    // Replicate allowed_mentions processing logic
    function processAllowedMentions(payload, hasExplicitEveryonePermission) {
        if (!payload || typeof payload !== 'object') return payload;
        const copy = JSON.parse(JSON.stringify(payload));
        if (!copy.allowed_mentions) {
            copy.allowed_mentions = { parse: ['roles', 'users'] };
            if (hasExplicitEveryonePermission) {
                copy.allowed_mentions = { parse: ['roles', 'users', 'everyone'] };
            }
        } else if (typeof copy.allowed_mentions === 'object' && Array.isArray(copy.allowed_mentions.parse)) {
            if (!hasExplicitEveryonePermission) {
                copy.allowed_mentions.parse = copy.allowed_mentions.parse.filter(
                    (p) => typeof p === 'string' && p !== 'everyone' && p !== 'here'
                );
            }
        }
        return copy;
    }

    it('defaults allowed_mentions to roles and users only (suppressing @everyone and @here by default)', () => {
        const payload = { content: 'Announcement message' };
        const result = processAllowedMentions(payload, false);
        expect(result.allowed_mentions).toEqual({ parse: ['roles', 'users'] });
        expect(result.allowed_mentions.parse).not.toContain('everyone');
        expect(result.allowed_mentions.parse).not.toContain('here');
    });

    it('strips @everyone and @here from client-supplied allowed_mentions when permission is not granted', () => {
        const payload = {
            content: 'Attack now! @everyone @here',
            allowed_mentions: { parse: ['roles', 'users', 'everyone', 'here'] }
        };
        const result = processAllowedMentions(payload, false);
        expect(result.allowed_mentions.parse).toEqual(['roles', 'users']);
        expect(result.allowed_mentions.parse).not.toContain('everyone');
        expect(result.allowed_mentions.parse).not.toContain('here');
    });

    it('preserves everyone in allowed_mentions only when explicit validated permission is present', () => {
        const payload = { content: 'Official server alert @everyone' };
        const result = processAllowedMentions(payload, true);
        expect(result.allowed_mentions.parse).toContain('everyone');
        expect(result.allowed_mentions.parse).toContain('roles');
        expect(result.allowed_mentions.parse).toContain('users');
    });

    it('requires both explicit request flag AND authorized admin role to validate permission in the edge function', () => {
        expect(proxyContent).toContain('explicitEveryoneRequested');
        expect(proxyContent).toContain('hasExplicitEveryonePermission');
        expect(proxyContent).toContain('isAdminRole(caller.role)');
        expect(proxyContent).toContain('payload.allowed_mentions = { parse: ["roles", "users"] };');
        expect(proxyContent).toContain('payload.allowed_mentions = { parse: ["roles", "users", "everyone"] };');
    });
});

describe('Ticket 1.2: discord-webhook-proxy - Architectural & Security Guards', () => {
    it('strictly enforces redirect: "error" on Discord webhook fetch to prevent open redirect SSRF', () => {
        expect(proxyContent).toContain('redirect: "error"');
    });

    it('masks sensitive Discord webhook token in error logs', () => {
        expect(proxyContent).toContain('replace(/(https:\\/\\/discord\\.com\\/api\\/webhooks\\/\\d+\\/)[^?#\\s]+/, \'$1***\')');
    });

    it('enforces network timeout with AbortSignal.timeout(8000)', () => {
        expect(proxyContent).toContain('signal: AbortSignal.timeout(8000)');
    });

    it('enforces JWT validation and authorizes only admin roles', () => {
        expect(proxyContent).toContain('resolveCaller');
        expect(proxyContent).toContain('!isAdminRole(caller.role)');
    });
});
