// /invite (2026-10-03): an officer posts a "Join <TAG>" link button. What must
// hold: authority comes from the caller's LINKED app account through the same
// isGuildInScope() the app uses, never from a Discord permission; the code
// rides in the URL fragment; and the post is a LINK button, so nothing comes
// back to the bot unhandled.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isGuildInScope } from '../supabase/functions/_shared/admin-authz.ts';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const worker = read('discord-verification-worker/index.js');
const edge = read('supabase/functions/discord-bot-interactions/index.ts');
const handler = edge.slice(
  edge.indexOf('if (commandName === "invite")'),
  edge.indexOf('// /update-stats replaces /power and /glory')
);

describe('/invite is declared by the worker and handled by the Edge Function', () => {
  it('is registered and forwarded', () => {
    expect(worker).toContain('["invite", INVITE_COMMAND]');
    expect(worker).toMatch(/const FORWARDED_COMMANDS = new Set\(\[[^\]]*"invite"/);
  });

  it('carries no Discord permission gate: the app account decides', () => {
    const def = worker.slice(
      worker.indexOf('const INVITE_COMMAND = {'),
      worker.indexOf('};', worker.indexOf('const INVITE_COMMAND = {'))
    );
    expect(def).not.toContain('default_member_permissions');
  });
});

describe('authorization', () => {
  it('reads the caller from discord_account_links, active non-member accounts only', () => {
    expect(handler).toContain('const officers = await officerAccounts(admin, discordUserId);');
    // The lookup itself is the shared one, executed in _shared/auth.test.ts.
    expect(edge).toContain('import { officerAccountsForDiscord } from "../_shared/auth.ts";');
    expect(edge).toContain('const officerAccounts = officerAccountsForDiscord;');
  });

  it("checks scope with the shared isGuildInScope against the guild's real server", () => {
    expect(edge).toMatch(/import \{[^}]*\bisGuildInScope\b[^}]*\} from "\.\.\/_shared\/admin-authz\.ts";/);
    expect(handler).toContain('.from("guilds").select("id, server_number").eq("id", target)');
    expect(handler).toContain(
      'officers.some((o) => isGuildInScope(o, target, (guildRow as any).server_number ?? null))'
    );
    // The scope check comes before the join code is ever read.
    expect(handler.indexOf('isGuildInScope(')).toBeLessThan(handler.indexOf('gm_get_join_code'));
  });

  it('the matrix it relies on refuses a guild_admin outside their guild', () => {
    expect(isGuildInScope({ role: 'guild_admin', guild: 'SIGMA', serverNumber: '1058' }, 'OMEGA', '1058')).toBe(false);
    expect(isGuildInScope({ role: 'guild_admin', guild: 'SIGMA', serverNumber: '1058' }, 'SIGMA', '1058')).toBe(true);
    expect(isGuildInScope({ role: 'server_admin', guild: null, serverNumber: '1058' }, 'OMEGA', '1089')).toBe(false);
  });

  it('validates a requested tag before querying', () => {
    expect(handler).toContain('/^[A-Z0-9_]{2,12}$/.test(target)');
  });
});

describe('the post', () => {
  it('is a LINK button to the #join= fragment, never the query string', () => {
    expect(handler).toContain('`${APP_URL}/#join=${encodeURIComponent(code)}`');
    expect(handler).toMatch(/\{ type: 2, style: 5, label: `Join \$\{target\}`, url: link \}/);
    expect(handler).not.toContain('?join=');
  });

  it('is posted with mentions disabled', () => {
    const post = read('supabase/functions/_shared/discord-verification.ts');
    const fn = post.slice(
      post.indexOf('export async function postChannelMessage'),
      post.indexOf('export async function sendDirectMessage')
    );
    expect(fn).toContain('allowed_mentions: { parse: [] }');
  });

  it('refuses outside a server channel', () => {
    expect(handler).toContain('if (!interaction.guild_id || !channelId)');
  });
});
