/**
 * tests/discord_server_provisioner.test.js
 *
 * Comprehensive unit and regression tests for Discord Server Provisioning & Templating:
 * - Dynamic slugification and template generation across multiple guild tenants (ALPHA, BABE, CLAW).
 * - Correct category, channel, and voice hierarchy mapping.
 * - Multi-tenant role permissions & Zero-Trust channel permission overwrites.
 * - Mocked provisioning flow, progress reporting, and Supabase guild_config auto-wiring.
 * - Architecture invariants: zero direct writes to accounts or guild_members, no banned_players mentions.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import {
  sanitizeSlug,
  buildServerTemplate,
  provisionDiscordServer,
  summarizeTemplate,
  storedChannelName,
} from '../discord-verification-worker/server-provisioner.js';

describe('Discord Server Provisioner: sanitizeSlug', () => {
  it('converts mixed strings, spaces and tags to lowercase channel slugs', () => {
    expect(sanitizeSlug('ALPHA')).toBe('alpha');
    expect(sanitizeSlug('[PR1M]')).toBe('pr1m');
    expect(sanitizeSlug('First Galactic Fleet')).toBe('first-galactic-fleet');
    expect(sanitizeSlug('Cool_Guild--1058')).toBe('cool_guild-1058');
    expect(sanitizeSlug('')).toBe('guild');
    expect(sanitizeSlug(null)).toBe('guild');
  });
});

describe('Discord Server Provisioner: buildServerTemplate', () => {
  it('generates dynamic template tailored to ALPHA guild ([PR1M], Server #1058)', () => {
    const template = buildServerTemplate({
      guildName: 'ALPHA',
      guildTag: 'PR1M',
      serverNumber: '1058',
    });

    expect(template.guildName).toBe('ALPHA');
    expect(template.guildTag).toBe('PR1M');
    expect(template.serverNumber).toBe('1058');
    expect(template.guildSlug).toBe('alpha');
    expect(template.tagSlug).toBe('pr1m');

    // Check roles. The three the verification flow resolves BY NAME carry no
    // emoji and no suffix: findRoleByNormalizedName only strips brackets and
    // upper-cases, so "👽 Visitor" and "🛡️ [PR1M] Member" could never be
    // matched and every fresh server hit the no_matching_role dead end
    // (ADR-020). Personality lives in the colour now.
    const roleNames = template.roles.map((r) => r.name);
    expect(roleNames).toContain('👑 [PR1M] R5');
    expect(roleNames).toContain('⭐ [PR1M] R4');
    expect(roleNames).toContain('[PR1M]');
    expect(roleNames).toContain('[VISITOR]');
    expect(roleNames).toContain('[PENDING]');

    // Check 7 categories
    expect(template.categories).toHaveLength(7);
    const catNames = template.categories.map((c) => c.name);
    expect(catNames).toEqual([
      '🛂 WELCOME',
      '👽 CROSS SERVER VISITORS',
      'GAME UPDATES',
      '⌛ EVENT REMINDERS',
      '🪐 SERVER #1058',
      '🚨 DOMINION WARZONE',
      '🔴 ALPHA',
    ]);

    // Check guild specific category channels
    const alphaCat = template.categories.find((c) => c.name === '🔴 ALPHA');
    expect(alphaCat).toBeDefined();
    const alphaChNames = alphaCat.channels.map((ch) => ch.name);
    expect(alphaChNames).toContain('📡・alpha-chat');
    expect(alphaChNames).toContain('🗓️・pr1m-leave-and-absence');
    expect(alphaChNames).toContain('👑・r4-chat');
    expect(alphaChNames).toContain('🎧・pr1m-voice');
    expect(alphaChNames).toContain('R4 VC');

    // Check voice channel types
    const voiceCh = alphaCat.channels.find((ch) => ch.name === '🎧・pr1m-voice');
    expect(voiceCh.type).toBe(ChannelType.GuildVoice);
    const r4VoiceCh = alphaCat.channels.find((ch) => ch.name === 'R4 VC');
    expect(r4VoiceCh.type).toBe(ChannelType.GuildVoice);
  });

  it('generates dynamic template tailored to BABE guild ([BABE], Server #2042)', () => {
    const template = buildServerTemplate({
      guildName: 'BABE',
      guildTag: 'BABE',
      serverNumber: 2042,
    });

    expect(template.guildName).toBe('BABE');
    expect(template.serverNumber).toBe('2042');

    const roleNames = template.roles.map((r) => r.name);
    expect(roleNames).toContain('👑 [BABE] R5');
    expect(roleNames).toContain('⭐ [BABE] R4');
    expect(roleNames).toContain('[BABE]');

    const catNames = template.categories.map((c) => c.name);
    expect(catNames).toContain('🪐 SERVER #2042');
    expect(catNames).toContain('🔴 BABE');

    const babeCat = template.categories.find((c) => c.name === '🔴 BABE');
    const babeChNames = babeCat.channels.map((ch) => ch.name);
    expect(babeChNames).toContain('📡・babe-chat');
    expect(babeChNames).toContain('🗓️・babe-leave-and-absence');
    expect(babeChNames).toContain('🎧・babe-voice');
  });

  it('enforces Zero-Trust permission isolation on sensitive rooms', () => {
    const template = buildServerTemplate({
      guildName: 'CLAW',
      guildTag: 'CLAW',
      serverNumber: '999',
    });

    const clawCat = template.categories.find((c) => c.name === '🔴 CLAW');
    // Everyone and visitors locked out of private guild category
    expect(clawCat.overwrites.everyone.ViewChannel).toBe(false);
    expect(clawCat.overwrites.visitor.ViewChannel).toBe(false);
    expect(clawCat.overwrites.member.ViewChannel).toBe(true);

    // r4-chat locked to regular members
    const r4Chat = clawCat.channels.find((ch) => ch.name === '👑・r4-chat');
    expect(r4Chat.overwrites.member.ViewChannel).toBe(false);
    expect(r4Chat.overwrites.officer.ViewChannel).toBe(true);

    // R4 VC locked to regular members
    const r4Vc = clawCat.channels.find((ch) => ch.name === 'R4 VC');
    expect(r4Vc.overwrites.member.ViewChannel).toBe(false);
    expect(r4Vc.overwrites.officer.Connect).toBe(true);

    // Verification channel allows @everyone upload
    const welcomeCat = template.categories.find((c) => c.name === '🛂 WELCOME');
    const verifChannel = welcomeCat.channels.find((ch) => ch.name === '🔐・verification');
    expect(verifChannel.overwrites.everyone.SendMessages).toBe(true);
    expect(verifChannel.overwrites.everyone.AttachFiles).toBe(true);
  });
});

describe('Discord Server Provisioner: provisionDiscordServer Execution', () => {
  function makeFakeDiscordGuild() {
    const rolesCreated = [];
    const channelsCreated = [];

    const everyoneRole = { id: 'role_everyone', name: '@everyone' };
    const rolesStore = new Map([['role_everyone', everyoneRole]]);
    const channelsStore = new Map();

    return {
      roles: {
        everyone: everyoneRole,
        fetch: vi.fn(async () => Array.from(rolesStore.values())),
        create: vi.fn(async (data) => {
          const role = { id: `role_${data.name}`, ...data };
          rolesStore.set(role.id, role);
          rolesCreated.push(role);
          return role;
        }),
      },
      channels: {
        fetch: vi.fn(async () => channelsStore),
        create: vi.fn(async (data) => {
          const channel = {
            id: `channel_${data.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
            send: vi.fn(async () => ({})),
            ...data,
          };
          channelsStore.set(channel.id, channel);
          channelsCreated.push(channel);
          return channel;
        }),
      },
      _state: { rolesCreated, channelsCreated },
    };
  }

  it('provisions complete server and auto-wires Supabase guild_config', async () => {
    const fakeGuild = makeFakeDiscordGuild();
    const upsertRows = [];
    const fakeSupabase = {
      from: (table) => ({
        upsert: vi.fn(async (rows) => {
          if (table === 'guild_config') upsertRows.push(...rows);
          return { error: null };
        }),
      }),
    };

    const progressUpdates = [];
    const onProgress = vi.fn(async (pct, text) => {
      progressUpdates.push({ pct, text });
    });

    const res = await provisionDiscordServer(
      fakeGuild,
      {
        guildName: 'ALPHA',
        guildTag: 'PR1M',
        serverNumber: '1058',
        cleanMode: false,
        rateLimitDelayMs: 0,
      },
      {
        supabase: fakeSupabase,
        onProgress,
      }
    );

    expect(res.ok).toBe(true);
    expect(res.createdCounts.roles).toBe(5); // + [PENDING]
    expect(res.createdCounts.categories).toBe(7);
    expect(res.createdCounts.channels).toBeGreaterThanOrEqual(28);

    // Check progress reporting
    expect(progressUpdates.length).toBeGreaterThan(5);
    expect(progressUpdates[0].pct).toBe(5);
    expect(progressUpdates[progressUpdates.length - 1].pct).toBe(100);

    // Check Supabase auto-wiring. Two rows, not three: `discord_member_role_id`
    // is deliberately no longer wired. It pointed at the tag-bearing
    // "[TAG] Member" role and the worker granted it on EVERY successful
    // verification, visitors included -- a second role that could leak exactly
    // what the roster gate withholds (ADR-020).
    expect(upsertRows).toHaveLength(2);
    const verifRow = upsertRows.find((r) => r.key === 'discord_verification_channel_id');
    const auditRow = upsertRows.find((r) => r.key === 'discord_audit_channel_id');
    const memberRoleRow = upsertRows.find((r) => r.key === 'discord_member_role_id');

    expect(verifRow).toBeDefined();
    expect(verifRow.guild).toBe('ALPHA');
    expect(verifRow.value).toContain('channel_');

    expect(auditRow).toBeDefined();
    expect(auditRow.guild).toBe('ALPHA');
    expect(auditRow.value).toContain('channel_');

    expect(memberRoleRow).toBeUndefined();
  });

  it('refuses to build anything without a game-server number', async () => {
    // It used to default to "1000" -- a number nobody entered, on a server
    // nobody plays on, baked into every channel name. That number is what
    // scopes guild-tag resolution (ADR-020) and the server_admin role.
    const fakeGuild = makeFakeDiscordGuild();
    await expect(provisionDiscordServer(fakeGuild, { guildName: 'DEMO', rateLimitDelayMs: 0 }, {})).rejects.toThrow(
      'server_number_required'
    );
    expect(fakeGuild.roles.create).not.toHaveBeenCalled();
  });

  it('handles clean mode by deleting pre-existing deletable channels', async () => {
    const fakeGuild = makeFakeDiscordGuild();
    const oldChannel = {
      id: 'old_general',
      name: 'general',
      deletable: true,
      delete: vi.fn(async () => {}),
    };
    fakeGuild.channels.fetch = vi.fn(async () => new Map([['old_general', oldChannel]]));

    const fakeSupabase = {
      from: () => ({ upsert: vi.fn(async () => ({ error: null })) }),
    };

    const res = await provisionDiscordServer(
      fakeGuild,
      {
        guildName: 'DEMO',
        // Required since ADR-020: the provisioner no longer invents "1000".
        serverNumber: '0000',
        cleanMode: true,
        rateLimitDelayMs: 0,
      },
      {
        supabase: fakeSupabase,
      }
    );

    expect(res.ok).toBe(true);
    expect(oldChannel.delete).toHaveBeenCalled();
  });
});

describe('Discord Server Provisioner: re-runs and the confirmation plan', () => {
  function makeGuild() {
    const everyoneRole = { id: 'role_everyone', name: '@everyone' };
    const roles = new Map([['role_everyone', everyoneRole]]);
    const channels = new Map();
    let n = 0;
    return {
      roles: {
        everyone: everyoneRole,
        fetch: vi.fn(async () => Array.from(roles.values())),
        create: vi.fn(async (data) => {
          const r = { id: `role_${n++}`, ...data };
          roles.set(r.id, r);
          return r;
        }),
      },
      channels: {
        fetch: vi.fn(async () => new Map(channels)),
        // Mimic Discord: text channel names are stored lower-cased, dashes for spaces.
        create: vi.fn(async (data) => {
          const ch = {
            id: `ch_${n++}`,
            ...data,
            name: storedChannelName(data.name, data.type),
            parentId: data.parent ?? null,
            send: vi.fn(async () => ({})),
          };
          channels.set(ch.id, ch);
          return ch;
        }),
      },
      _channels: channels,
    };
  }
  const opts = { guildName: 'ALPHA', guildTag: 'PR1M', serverNumber: '1058', rateLimitDelayMs: 0 };
  const supa = { from: () => ({ upsert: vi.fn(async () => ({ error: null })) }) };

  it('a second run creates nothing, keeps the wiring, and does not repost the welcome embeds', async () => {
    const g = makeGuild();
    const first = await provisionDiscordServer(g, opts, { supabase: supa });
    const plan = summarizeTemplate(buildServerTemplate(opts));
    expect(first.createdCounts).toEqual({ roles: plan.roles, categories: plan.categories, channels: plan.channels });
    const countAfterFirst = g._channels.size;
    const verif = first.autoWired.verificationChannelId;
    const sendsAfterFirst = g._channels.get(verif).send.mock.calls.length;

    const second = await provisionDiscordServer(g, opts, { supabase: supa });
    expect(second.ok).toBe(true);
    expect(second.createdCounts).toEqual({ roles: 0, categories: 0, channels: 0 });
    expect(second.reusedCounts).toEqual({ roles: plan.roles, categories: plan.categories, channels: plan.channels });
    expect(g._channels.size).toBe(countAfterFirst);
    expect(second.autoWired.verificationChannelId).toBe(verif);
    expect(g._channels.get(verif).send.mock.calls.length).toBe(sendsAfterFirst);
  });

  it('repairs a server by adding only what is missing', async () => {
    const g = makeGuild();
    await provisionDiscordServer(g, opts, { supabase: supa });
    const victim = Array.from(g._channels.values()).find(
      (c) => c.type !== 4 && !String(c.name).includes('verification')
    );
    g._channels.delete(victim.id);
    const res = await provisionDiscordServer(g, opts, { supabase: supa });
    expect(res.createdCounts.channels).toBe(1);
    expect(res.createdCounts.categories).toBe(0);
  });

  it('counts the plan from the template, not from a hand-written summary', () => {
    const plan = summarizeTemplate(buildServerTemplate(opts));
    expect(plan.roles).toBe(5);
    expect(plan.categories).toBe(7);
    expect(plan.textChannels + plan.voiceChannels).toBe(plan.channels);
    expect(plan.roleNames).toContain('[PENDING]');
    const worker = fs.readFileSync(path.resolve(__dirname, '../discord-verification-worker/index.js'), 'utf-8');
    expect(worker).not.toContain('28 Text, 3 Voice');
    expect(worker).toContain('summarizeTemplate(buildServerTemplate(');
  });
});

describe('Architectural & Security Invariants: server-provisioner', () => {
  const provisionerPath = path.resolve(__dirname, '../discord-verification-worker/server-provisioner.js');
  const provisionerCode = fs.readFileSync(provisionerPath, 'utf-8');

  const indexPath = path.resolve(__dirname, '../discord-verification-worker/index.js');
  const indexCode = fs.readFileSync(indexPath, 'utf-8');

  it('never references banned_players anywhere in the server provisioner or worker', () => {
    expect(provisionerCode).not.toContain('banned_players');
    expect(indexCode).not.toContain('banned_players');
  });

  it('never executes raw mutations on accounts or guild_members directly', () => {
    // Both modules should never touch accounts or guild_members tables directly with mutations
    expect(provisionerCode).not.toMatch(/\.from\(["']accounts["']\)\.(insert|update|upsert|delete)/);
    expect(provisionerCode).not.toMatch(/\.from\(["']guild_members["']\)\.(insert|update|upsert|delete)/);
    expect(indexCode).not.toMatch(/\.from\(["']accounts["']\)\.(insert|update|upsert|delete)/);
    expect(indexCode).not.toMatch(/\.from\(["']guild_members["']\)\.(insert|update|upsert|delete)/);
  });
});
