// /link is retired (2026-10-03). These pin what replaced it: the bot points
// people at Discord sign-in, and the Portal's My Info card either confirms the
// link or moves a password account to Discord through the claim, which is the
// only path that retires the password.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const worker = read('discord-verification-worker/index.js');
const interactions = read('supabase/functions/discord-bot-interactions/index.ts');
const memberPortal = strip(read('supabase/functions/member-portal/index.ts'));
const portal = strip(read('src/modules/portal/views/PortalView.ts'));
const help = read('src/modules/help/HelpView.ts');

describe('the bot stops sending people to /link', () => {
  it('no reply in the worker or the Edge Function says to run /link', () => {
    for (const [name, src] of [['worker', worker], ['interactions', interactions]]) {
      const replies = [...src.matchAll(/content:\s*([^\n]+)/g)].map((m) => m[1]).join('\n');
      expect(replies, name).not.toMatch(/Run `\/link`|run \\`\/link\\`/);
    }
    expect(interactions).not.toContain('Run `/link`');
  });

  it('every "not linked" answer points to Continue with Discord and the app', () => {
    expect(worker).toMatch(/const NOT_LINKED_TEXT =[\s\S]{0,200}Continue with Discord[\s\S]{0,120}APP_URL/);
    expect(interactions).toMatch(/const NOT_LINKED_MSG =[\s\S]{0,220}Continue with Discord[\s\S]{0,120}APP_URL/);
    expect((worker.match(/content: NOT_LINKED_TEXT/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('defaults the app URL without making it a required Render variable', () => {
    expect(worker).toMatch(/const APP_URL = \(\(process\.env\.APP_URL \|\| ""\)\.trim\(\) \|\| "https:\/\/guildmanagement\.vercel\.app"\)/);
    const required = worker.slice(worker.indexOf('const REQUIRED_ENV = {'), worker.indexOf('};', worker.indexOf('const REQUIRED_ENV = {')));
    expect(required).not.toContain('APP_URL');
  });
});

describe('the Portal card replaces the code box', () => {
  it('reports whether the account is linked, never the Discord id', () => {
    const block = memberPortal.slice(memberPortal.indexOf('if (action === "get-active-sessions")'));
    expect(block).toContain('.from("discord_account_links")');
    expect(block).toContain('{ count: "exact", head: true }');
    expect(block).toContain('.eq("account_id", identity.accountId)');
    expect(block).toContain('discord_linked:');
  });

  it('has no code input and no confirm-discord-link call any more', () => {
    expect(portal).not.toContain('portal-discord-code-input');
    expect(portal).not.toContain("'confirm-discord-link'");
  });

  it('moves a password account to Discord through the claim, saving the intent AFTER logout', () => {
    expect(portal).toContain('Switch to Discord sign-in');
    const handler = portal.slice(portal.indexOf("getElementById('portal-discord-switch-btn')"));
    // logout() clears sessionStorage, so the intent must be written after it.
    expect(handler).toMatch(/legacy\.logout\(\)\.then\(go\)\.catch\(go\)/);
    const go = handler.slice(handler.indexOf('const go = ()'), handler.indexOf('legacy.logout()'));
    expect(go).toContain("savePendingIntent({ kind: 'claim', accountId })");
    expect(go).toContain('loginWithDiscord()');
    expect(go).not.toMatch(/password/i);
  });

  it('the help text describes Discord sign-in, not /link', () => {
    const entry = help.slice(help.indexOf("'help-portal-discord-link'"), help.indexOf("'help-portal-transfer'"));
    expect(entry).not.toContain('/link');
    expect(entry).toContain('Continue with Discord');
  });
});
