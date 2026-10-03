// Approve / Reject a join request from Discord (2026-10-03).
//
// The sensitive part of the bot rework: a button click now changes an
// account's status. What must hold: the clicker's authority is their linked
// officer account checked with the app's canManageAccount(); the decision runs
// through the same shared code the app uses; rejecting asks once; the custom_id
// is re-validated; and a decided request loses its buttons.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canManageAccount } from '../supabase/functions/_shared/admin-authz.ts';
import { edgeSource } from './helpers/edge-source.js';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const edge = read('supabase/functions/discord-bot-interactions/index.ts');
const handler = strip(edge.slice(edge.indexOf('async function handleJoinRequestButton'), edge.indexOf('Deno.serve(')));
const worker = read('discord-verification-worker/index.js');
const authDiscord = edgeSource('auth-discord');

describe('the join-request message carries the buttons', () => {
  it('posts Approve / Reject with gmjoin custom ids', () => {
    const announce = authDiscord.slice(authDiscord.indexOf('async function announceJoinRequest'));
    expect(announce).toContain('custom_id: `gmjoin:approve:${accountId}`');
    expect(announce).toContain('custom_id: `gmjoin:reject:${accountId}`');
  });
});

describe('the worker forwards the click, nothing more', () => {
  it('routes gmjoin: buttons to the Edge Function', () => {
    expect(worker).toMatch(/customId\.startsWith\("gmjoin:"\)\) \{\s*await forwardInteraction\(interaction\);/);
  });

  it('forwards only the custom_id and the message id', () => {
    const raw = worker.slice(worker.indexOf('function toRawInteraction'), worker.indexOf('async function forwardInteraction'));
    expect(raw).toContain('type: 3,');
    expect(raw).toContain('data: { custom_id: interaction.customId, component_type: 2 }');
    expect(raw).toContain('message: interaction.message ? { id: interaction.message.id } : null');
  });

  it('relays a non-link button only when it routes back through gmjoin:', () => {
    const relay = worker.slice(worker.indexOf('const relayable = (c)'), worker.indexOf('if (!content && embeds.length === 0)'));
    expect(relay).toContain('(c.style !== 5 && /^gmjoin:/.test(String(c.custom_id || "")))');
  });
});

describe('the Edge Function decides', () => {
  it('re-validates the custom_id shape', () => {
    expect(handler).toContain('/^gmjoin:(approve|reject|rejectok):([A-Za-z0-9_]{1,64})(?::(\\d{17,20}))?$/');
  });

  it('takes authority from the linked officer account, checked with canManageAccount', () => {
    expect(handler).toContain('const officers = await officerAccounts(admin, discordUserId);');
    expect(handler).toContain('const officer = officers.find((o) => canManageAccount(o, targetCtx));');
    expect(handler.indexOf('canManageAccount(')).toBeLessThan(handler.indexOf('decideRegistration('));
  });

  it('runs the shared decision, labelled as coming from Discord', () => {
    expect(handler).toContain('decideRegistration(');
    expect(handler).toContain('accountId: officer.id, via: "discord"');
    expect(handler).not.toContain('gm_approve_player_account');
    expect(handler).not.toContain('gm_reject_player_account');
  });

  it('asks before rejecting, and the first Reject click decides nothing', () => {
    const rejectBranch = handler.slice(handler.indexOf('if (action === "reject")'), handler.indexOf('const decision ='));
    expect(rejectBranch).toContain('Yes, reject');
    expect(rejectBranch).toContain('custom_id: `gmjoin:rejectok:${targetId}:${requestMessageId}`');
    expect(rejectBranch).not.toContain('decideRegistration(');
  });

  it('strips the buttons once decided, or when already handled', () => {
    expect((handler.match(/components: \[\],/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(handler).toContain('editChannelMessage(channelId, requestMessageId');
  });

  it('the matrix it relies on keeps a guild_admin to their own guild', () => {
    const officer = { role: 'guild_admin', guild: 'SIGMA', serverNumber: '1058' };
    expect(canManageAccount(officer, { role: 'member', guild: 'SIGMA', serverNumber: '1058' })).toBe(true);
    expect(canManageAccount(officer, { role: 'member', guild: 'OMEGA', serverNumber: '1058' })).toBe(false);
  });
});

describe('the app warns when join requests would be announced nowhere', () => {
  const html = read('index.html');
  const ctrl = read('src/modules/app/admin/guild-requests.controller.ts');

  it('has a warning under the officers channel field, hidden by default', () => {
    expect(html).toMatch(/id="discord-audit-channel-warning" class="[^"]*hidden"/);
  });

  it('shows it while the field is empty, and follows typing', () => {
    const fn = ctrl.slice(ctrl.indexOf('function refreshAuditChannelWarning'), ctrl.indexOf('export async function loadGuildSettings'));
    expect(fn).toContain("warning.classList.toggle('hidden', input.value.trim() !== '')");
    expect(fn).toContain("input.addEventListener('input', refreshAuditChannelWarning)");
    const load = ctrl.slice(ctrl.indexOf('export async function loadGuildSettings'));
    expect(load).toContain('refreshAuditChannelWarning();');
  });
});
