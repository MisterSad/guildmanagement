// ARC-04, remainder (medium-term plan, M2): the browser neither reads, stores
// nor writes a Discord webhook URL. It learns which webhooks are set through
// gm_configured_webhooks and writes through discord-webhook-proxy's
// `set-webhook`. The database side is proven by supabase/tests/09_webhook_urls.sql,
// the proxy side by supabase/functions/discord-webhook-proxy/index.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const client = {
  from: vi.fn(),
  rpc: vi.fn(),
  functions: { invoke: vi.fn() },
  auth: { getSession: vi.fn(async () => ({ data: { session: null } })) }
};

vi.mock('../src/core/api/supabase', () => ({
  getClient: () => client,
  ensureAuthSession: async () => {}
}));
vi.mock('../src/core/auth/roles', () => ({ getActiveGuild: () => 'TA' }));

// tests/setup.js has already loaded these modules for the GM bridge, with the
// real client: load them again, against the mocks.
vi.resetModules();
const { getGuildConfig, setGuildConfig, isWebhookKey, purgeLocalWebhookCopies } = await import('../src/core/config/guild-config');
const { configuredWebhooks, webhookChainIsSet, setDiscordWebhook, sendDiscordWebhookDetailed } = await import('../src/core/integrations/discord');

beforeEach(() => {
  client.from.mockReset();
  client.rpc.mockReset();
  client.functions.invoke.mockReset();
});

describe('guild-config never touches a webhook URL', () => {
  it('isWebhookKey matches public.gm_is_webhook_key', () => {
    expect(isWebhookKey('discord_webhook_url')).toBe(true);
    expect(isWebhookKey('webhook_gvg_opponent')).toBe(true);
    expect(isWebhookKey('discord_role_id')).toBe(false);
    expect(isWebhookKey('coeff_svs')).toBe(false);
  });

  it('reading a webhook key queries nothing and returns empty, even with a local copy', async () => {
    localStorage.setItem('gm_config_TA_webhook_gvg', 'https://example.test/old');
    expect(await getGuildConfig('webhook_gvg')).toBe('');
    expect(client.from).not.toHaveBeenCalled();
  });

  it('writing a webhook key is refused before any request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await setGuildConfig('discord_webhook_url', 'https://example.test/x')).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
    expect(localStorage.getItem('gm_config_TA_discord_webhook_url')).toBeNull();
    err.mockRestore();
  });

  it('copies earlier versions left in localStorage are deleted; other keys stay', async () => {
    const mod = await import('../src/core/config/guild-config?fresh');
    localStorage.setItem('gm_config_TA_webhook_svs', 'x');
    localStorage.setItem('gm_config_TB_discord_webhook_url', 'x');
    localStorage.setItem('gm_config_TA_coeff_svs', '1.5');
    mod.purgeLocalWebhookCopies();
    expect(localStorage.getItem('gm_config_TA_webhook_svs')).toBeNull();
    expect(localStorage.getItem('gm_config_TB_discord_webhook_url')).toBeNull();
    expect(localStorage.getItem('gm_config_TA_coeff_svs')).toBe('1.5');
    expect(typeof purgeLocalWebhookCopies).toBe('function');
  });
});

describe('the Discord integration asks which webhooks are set, never what they are', () => {
  it('configuredWebhooks calls the RPC for the active guild', async () => {
    client.rpc.mockResolvedValue({ data: ['webhook_gvg'], error: null });
    expect(await configuredWebhooks()).toEqual(['webhook_gvg']);
    expect(client.rpc).toHaveBeenCalledWith('gm_configured_webhooks', { p_guild: 'TA' });
  });

  it('configuredWebhooks tells "unknown" from "none"', async () => {
    client.rpc.mockResolvedValue({ data: null, error: { message: 'forbidden' } });
    expect(await configuredWebhooks()).toBeNull();
  });

  it('webhookChainIsSet follows the proxy chain: own key, default, any other', () => {
    expect(webhookChainIsSet(['webhook_gvg_opponent'], 'gvg_opponent')).toBe(true);
    expect(webhookChainIsSet(['discord_webhook_url'], 'svs')).toBe(true);
    expect(webhookChainIsSet(['webhook_dtr'], 'svs')).toBe(true);
    expect(webhookChainIsSet(['webhook_gvg_opponent'], 'svs')).toBe(false);
    expect(webhookChainIsSet([], 'svs')).toBe(false);
    expect(webhookChainIsSet(null, 'svs')).toBe(false);
  });

  it('setDiscordWebhook sends the URL to the proxy once, never to the table', async () => {
    client.functions.invoke.mockResolvedValue({ data: { ok: true, configured: true }, error: null });
    const res = await setDiscordWebhook('webhook_gvg', '  https://discord.com/api/webhooks/1/x  ');
    expect(res.ok).toBe(true);
    expect(client.functions.invoke).toHaveBeenCalledWith('discord-webhook-proxy', {
      body: { action: 'set-webhook', guild: 'TA', key: 'webhook_gvg', url: 'https://discord.com/api/webhooks/1/x' }
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it('setDiscordWebhook surfaces the proxy refusal', async () => {
    client.functions.invoke.mockResolvedValue({ data: { ok: false, error: 'invalid_discord_webhook_url' }, error: null });
    expect(await setDiscordWebhook('webhook_gvg', 'https://evil.example/x')).toEqual({ ok: false, error: 'invalid_discord_webhook_url' });
  });

  it('sending names the event, never a URL, and refuses a URL given in its place', async () => {
    client.functions.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    expect((await sendDiscordWebhookDetailed('gvg', { content: 'hi' })).ok).toBe(true);
    const body = client.functions.invoke.mock.calls[0][1].body;
    expect(body.eventPrefix).toBe('gvg');
    expect(body.webhookUrl).toBeUndefined();
    expect(body.url).toBeUndefined();
    expect(await sendDiscordWebhookDetailed('https://discord.com/api/webhooks/1/x', { content: 'hi' }))
      .toEqual({ ok: false, error: 'client_webhook_url_not_allowed' });
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe('no front-end query reads a webhook row', () => {
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.ts$/.test(e.name) ? [p] : [];
    });
  }

  it('no src file queries guild_config for a webhook key or reads one through getGuildConfig', () => {
    const offenders = [];
    for (const f of walk(path.resolve(__dirname, '../src'))) {
      const src = fs.readFileSync(f, 'utf-8');
      if (/from\(['"]guild_config['"]\)[^;]*(webhook_|discord_webhook_url|DISCORD_WEBHOOK_KEYS)/s.test(src.replace(/;[\s\S]*?(?=from\()/g, ';'))) offenders.push(f);
      if (/(getGuildConfig|configGet|config\.get)\(\s*['"`](webhook_|discord_webhook_url)/.test(src)) offenders.push(f);
      if (/(getGuildConfig|configGet|config\.get)\(\s*['"`]webhook_['"`]\s*\+/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
