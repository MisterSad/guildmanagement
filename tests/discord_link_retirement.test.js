// /link is retired (2026-10-03). These pin what replaced it: the bot points
// people at Discord sign-in, and the Portal's My Info card either confirms the
// link or moves a password account to Discord through the claim, which is the
// only path that retires the password.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const worker = read('discord-verification-worker/index.js');
const interactions = read('supabase/functions/discord-bot-interactions/index.ts');
const _memberPortal = strip(edgeSource('member-portal'));
const portal = strip(read('src/modules/portal/views/PortalView.ts'));
const help = read('src/modules/help/HelpView.ts');

describe('the bot stops sending people to /link', () => {
  it('no reply in the worker or the Edge Function says to run /link', () => {
    for (const [name, src] of [
      ['worker', worker],
      ['interactions', interactions],
    ]) {
      const replies = [...src.matchAll(/content:\s*([^\n]+)/g)].map((m) => m[1]).join('\n');
      expect(replies, name).not.toMatch(/Run `\/link`|run \\`\/link\\`/);
    }
    expect(interactions).not.toContain('Run `/link`');
  });

  it('every "not linked" answer points to Continue with Discord, with a button to the app', () => {
    expect(worker).toMatch(/const NOT_LINKED_TEXT =[\s\S]{0,200}Continue with Discord/);
    expect(worker).toMatch(
      /function notLinkedReply\(\) \{\s*return \{ content: NOT_LINKED_TEXT, components: appLinkRow\("Continue with Discord"\), ephemeral: true \};/
    );
    expect((worker.match(/await interaction\.reply\(notLinkedReply\(\)\)/g) || []).length).toBe(3);
    expect(interactions).toMatch(/const NOT_LINKED_MSG =[\s\S]{0,220}Continue with Discord/);
    expect(interactions).toContain(
      'return { ok: false, message: NOT_LINKED_MSG, components: appLinkRow("Continue with Discord") };'
    );
    expect((interactions.match(/ephemeral\(resolved\.message, undefined, resolved\.components\)/g) || []).length).toBe(
      4
    );
  });

  it('defaults the app URL without making it a required Render variable', () => {
    expect(worker).toMatch(
      /const APP_URL = \(\(process\.env\.APP_URL \|\| ""\)\.trim\(\) \|\| "https:\/\/guildmanagement\.vercel\.app"\)/
    );
    const required = worker.slice(
      worker.indexOf('const REQUIRED_ENV = {'),
      worker.indexOf('};', worker.indexOf('const REQUIRED_ENV = {'))
    );
    expect(required).not.toContain('APP_URL');
  });
});

describe('the Portal card replaces the code box', () => {
  it('reports whether the account is linked, never the Discord id', () => {
    const block = strip(edgeFunctionBody('member-portal', 'getActiveSessions'));
    expect(block).toContain('.from("discord_account_links")');
    expect(block).toContain('{ count: "exact", head: true }');
    expect(block).toContain('.eq("account_id", identity.accountId)');
    expect(block).toContain('discord_linked:');
  });

  it('has no code input and no confirm-discord-link call any more', () => {
    expect(portal).not.toContain('portal-discord-code-input');
    expect(portal).not.toContain("'confirm-discord-link'");
    // The service wrapper outlived the card by one release; nothing in the
    // client may name the removed action.
    expect(strip(read('src/modules/portal/portal.service.ts'))).not.toContain('confirm-discord-link');
  });

  it('moves a password account to Discord through the claim, saving the intent AFTER logout', () => {
    expect(portal).toContain('Switch to Discord sign-in');
    const handler = portal.slice(portal.indexOf("getElementById('portal-discord-switch-btn')"));
    // logout() clears sessionStorage, so the intent must be written after it.
    expect(handler).toMatch(/logout\(\)\.then\(go\)\.catch\(go\)/);
    const go = handler.slice(handler.indexOf('const go = ()'), handler.indexOf('logout().then(go)'));
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

describe('buttons the bot sends (phase B)', () => {
  it('uses LINK buttons (style 5) to the app, never a button that calls back', () => {
    const row = worker.slice(
      worker.indexOf('function appLinkRow('),
      worker.indexOf('\n}\n', worker.indexOf('function appLinkRow('))
    );
    expect(row).toContain('{ type: 2, style: 5, label, url }');
    expect(interactions).toContain('{ type: 2, style: 5, label, url: APP_URL }');
  });

  it('relays only https link buttons from the Edge Function', () => {
    const relay = worker.slice(
      worker.indexOf('async function forwardInteraction'),
      worker.indexOf('// Slash commands')
    );
    expect(relay).toContain('c.style === 5');
    expect(relay).toMatch(/\/\^https:\\\/\\\/\//);
    expect(relay).toContain('...(components.length ? { components } : {})');
  });

  it('offers the Player Portal after a roster-confirmed verification only', () => {
    const dm = worker.slice(
      worker.indexOf('async function sendVerificationDm'),
      worker.indexOf('async function postVerificationAuditLog')
    );
    expect(dm).toContain(
      'const portal = isGuildMember ? await portalInvitation(author.id, fgfGuild, result.uid) : null;'
    );
    const inv = worker.slice(
      worker.indexOf('async function portalInvitation'),
      worker.indexOf('async function sendVerificationDm')
    );
    // Linked already: open the Portal. Otherwise the guild invite link.
    expect(inv).toContain('.from("discord_account_links")');
    expect(inv).toContain('supabase.rpc("gm_get_join_code", { p_guild: fgfGuild })');
    expect(inv).toContain('`${APP_URL}/#join=${encodeURIComponent(code)}`');
    // Best-effort: a failure must not cost the player their verification DM.
    expect(inv).toMatch(/catch \(e\) \{[\s\S]{0,120}return null;/);
  });

  it('labels the /setup-server buttons in English', () => {
    expect(worker).toContain('.setLabel("🚀 Confirm and deploy")');
    expect(worker).toContain('.setLabel("❌ Cancel")');
    expect(worker).not.toMatch(/Confirmer|Annuler|Déployer/);
  });
});
