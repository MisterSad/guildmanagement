import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Discord Webhook & Reminders Regression Guard', () => {
  const eventRemindersPath = path.resolve(__dirname, '../supabase/functions/event-reminders/index.ts');
  const eventRemindersContent = fs.readFileSync(eventRemindersPath, 'utf-8');

  const discordPath = path.resolve(__dirname, '../src/core/integrations/discord.ts');
  const discordContent = fs.readFileSync(discordPath, 'utf-8');

  const membersPath = path.resolve(__dirname, '../src/modules/members/members.service.ts');
  const membersContent = fs.readFileSync(membersPath, 'utf-8');

  const proxyPath = path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts');
  const proxyContent = fs.readFileSync(proxyPath, 'utf-8');

  it('verifies event-reminders STATIC_CONFIG_KEYS includes all 6 event webhook keys and fallback', () => {
    expect(eventRemindersContent).toContain("'webhook_gvg'");
    expect(eventRemindersContent).toContain("'webhook_svs'");
    expect(eventRemindersContent).toContain("'webhook_calamity'");
    expect(eventRemindersContent).toContain("'discord_webhook_url'");

    // Extract the STATIC_CONFIG_KEYS array text from the edge function
    const match = eventRemindersContent.match(/const STATIC_CONFIG_KEYS:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    const keysText = match[1];

    expect(keysText).toContain("'webhook_gvg'");
    expect(keysText).toContain("'webhook_svs'");
    expect(keysText).toContain("'webhook_calamity'");
    expect(keysText).toContain("'discord_webhook_url'");
  });

  it('ensures frontend sendDiscordWebhookDetailed does not supply client webhookUrl or url to discord-webhook-proxy', () => {
    // Ensuring rawClientWebhook is never triggered for guild_admin / server_admin
    expect(discordContent).toContain('delete payloadToSend.webhookUrl;');
    expect(discordContent).toContain('delete payloadToSend.url;');
    expect(discordContent).toContain('allowEveryoneMention: true');
  });

  it('ensures discord.ts includes Authorization Bearer header on raw proxy fallback', () => {
    expect(discordContent).toContain("rawHeaders['Authorization'] = authHeader;");
    expect(discordContent).toContain("authHeader = 'Bearer ' + token;");
  });

  it('members.service.ts no longer touches Discord or webhook URLs at all', () => {
    // Its roster-share helper had no caller, prompted for a webhook URL, saved
    // it from the browser and POSTed to Discord when the proxy refused. Removed
    // (audit ARC-04); see tests/discord_no_direct_webhook.test.js.
    expect(membersContent).not.toContain('shareMatchupRosterToDiscord');
    expect(membersContent).not.toMatch(/webhook/i);
    expect(membersContent).not.toContain('fetch(');
  });

  it('verifies discord-webhook-proxy and frontend payload contracts are mutually compatible', () => {
    // discord-webhook-proxy rules:
    // 1. If caller is guild_admin and rawClientWebhook is truthy -> 403 forbidden_client_webhook_url
    // 2. If allowEveryoneMention is true -> preserves everyone in allowed_mentions
    expect(proxyContent).toContain('if (caller.role === "guild_admin" && rawClientWebhook)');
    expect(proxyContent).toContain('return json({ ok: false, error: "forbidden_client_webhook_url" }, 403);');

    // Frontend guarantees rawClientWebhook is empty:
    expect(discordContent).toContain('delete payloadToSend.webhookUrl;');
    expect(discordContent).toContain('delete payloadToSend.url;');

    // Frontend guarantees allowEveryoneMention is enabled:
    expect(discordContent).toContain('allowEveryoneMention: true');
    expect(proxyContent).toContain('body?.allowEveryoneMention === true');
  });
});
