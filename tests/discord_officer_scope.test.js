// Regression guard for audit point 6 (2026-10-03): cross-tenant actions
// reachable from Discord and from event-reminders.
//   SEC-09 / BE-A-03  /setup-server let any Discord admin rewire any guild.
//   BE-A-04           /profile searched every guild, unescaped, in public.
//   SEC-06 / BE-A-07  event-reminders ran every guild for any guild_admin JWT.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as worker from '../discord-verification-worker/officer-scope.js';
import * as edge from '../supabase/functions/_shared/admin-authz.ts';
import { escapeLike as edgeEscapeLike } from '../supabase/functions/_shared/like.ts';
import { edgeSource } from './helpers/edge-source.js';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

/** Minimal supabase-js stand-in: from(table).select().eq()/in()/maybeSingle(). */
function fakeSupabase(tables, { failOn } = {}) {
  return {
    from(table) {
      let rows = tables[table] || [];
      const q = {
        select() {
          return q;
        },
        eq(col, val) {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        in(col, vals) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return q;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve) {
          if (failOn === table) return resolve({ data: null, error: new Error('boom') });
          return resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
}

describe('the worker mirrors the Edge Functions authorization rules', () => {
  const roles = ['super_admin', 'server_admin', 'guild_admin', 'member', 'R4', 'R5', 'admin', null, ''];
  const guilds = ['ALPHA', 'alpha', 'BETA', null];
  const servers = ['101', 101, '202', null, ''];

  it('normalizeRole agrees on every role string', () => {
    for (const r of roles) expect(worker.normalizeRole(r), String(r)).toBe(edge.normalizeRole(r));
  });

  it('isGuildInScope agrees on the full matrix', () => {
    let cases = 0;
    for (const role of roles)
      for (const cg of guilds)
        for (const cs of servers)
          for (const tg of guilds)
            for (const ts of servers) {
              const caller = { role: role ? edge.normalizeRole(role) : null, guild: cg, serverNumber: cs };
              expect(worker.isGuildInScope(caller, tg, ts)).toBe(edge.isGuildInScope(caller, tg, ts));
              cases++;
            }
    expect(cases).toBeGreaterThan(1000);
  });

  it('escapeLike agrees with _shared/like.ts', () => {
    for (const s of ['%', '_', '\\', 'Ares_Actual', '50%\\_x', '', 'plain']) {
      expect(worker.escapeLike(s)).toBe(edgeEscapeLike(s));
    }
  });
});

describe('officer resolution from a Discord identity', () => {
  const tables = {
    discord_account_links: [
      { discord_user_id: 'd1', account_id: 'OfficerA' },
      { discord_user_id: 'd1', account_id: 'PlayerA' },
      { discord_user_id: 'd2', account_id: 'Suspended' },
      { discord_user_id: 'd3', account_id: 'ServerAdmin' },
    ],
    accounts: [
      { id: 'OfficerA', role: 'guild_admin', guild: 'ALPHA', server_number: null, status: 'active' },
      { id: 'PlayerA', role: 'member', guild: 'BETA', server_number: null, status: 'active' },
      { id: 'Suspended', role: 'guild_admin', guild: 'BETA', server_number: null, status: 'suspended' },
      { id: 'ServerAdmin', role: 'server_admin', guild: 'ALPHA', server_number: null, status: 'active' },
    ],
    guilds: [
      { id: 'ALPHA', server_number: '101' },
      { id: 'BETA', server_number: '101' },
      { id: 'GAMMA', server_number: '202' },
    ],
  };
  const db = fakeSupabase(tables);

  it('keeps active officers only, with their server number derived from their guild', async () => {
    expect(await worker.officerAccounts(db, 'd1')).toEqual([
      { id: 'OfficerA', role: 'guild_admin', guild: 'ALPHA', serverNumber: '101' },
    ]);
    expect(await worker.officerAccounts(db, 'd2')).toEqual([]);
    expect(await worker.officerAccounts(db, 'nobody')).toEqual([]);
  });

  it('a guild_admin covers their guild only; a member link grants nothing', async () => {
    expect(await worker.isOfficerOf(db, 'd1', 'ALPHA', '101')).toBe(true);
    expect(await worker.isOfficerOf(db, 'd1', 'BETA', '101')).toBe(false);
  });

  it('a server_admin covers the guilds of their server only', async () => {
    expect(await worker.isOfficerOf(db, 'd3', 'BETA', '101')).toBe(true);
    expect(await worker.isOfficerOf(db, 'd3', 'GAMMA', '202')).toBe(false);
  });

  it('a suspended officer, an unlinked user and a failed lookup are all refused', async () => {
    expect(await worker.isOfficerOf(db, 'd2', 'BETA', '101')).toBe(false);
    expect(await worker.isOfficerOf(db, 'nobody', 'ALPHA', '101')).toBe(false);
    const broken = fakeSupabase(tables, { failOn: 'discord_account_links' });
    expect(await worker.isOfficerOf(broken, 'd1', 'ALPHA', '101')).toBe(false);
  });
});

describe('worker commands use it', () => {
  const src = read('discord-verification-worker/index.js');
  const fn = (name) => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\nasync function ', start + 10));
  };

  it('/setup-server requires an officer of the target guild before anything is staged', () => {
    const body = fn('handleSetupServer');
    const check = body.indexOf('isOfficerOf(supabase, interaction.user.id, guildRow.id, guildRow.server_number)');
    expect(check).toBeGreaterThan(-1);
    expect(body.indexOf('pendingSetups.set(')).toBeGreaterThan(check);
  });

  it('/profile is scoped to the caller guild, escaped, ephemeral, and hides the absence reason', () => {
    const body = fn('handleProfile');
    expect(body).toContain('.eq("guild", callerGuild)');
    expect(body).toContain('.ilike("pseudo", escapeLike(ingameName.trim()))');
    expect(body).toContain('linked.guild !== callerGuild');
    expect(body).toContain('content: note || "", ephemeral: true');
    expect(body).not.toContain('activeAbsence.note');
  });
});

describe('event-reminders accepts machine callers only', () => {
  const src = edgeSource('event-reminders');

  it('no longer authenticates user JWTs', () => {
    expect(src).not.toContain('validateCallerAuth');
    expect(src).not.toContain("caller.role === 'guild_admin'");
  });

  it('authorizes the cron secret and the service role, nothing else', () => {
    const start = src.indexOf('const isAuthorized =');
    const gate = src.slice(start, src.indexOf(';', start));
    expect(gate).toContain('safeEqual(xCronSecret, cronSecret)');
    expect(gate).toContain('safeEqual(authBearer, serviceRoleKey)');
    expect(gate.match(/safeEqual\(/g)).toHaveLength(3);
  });
});
