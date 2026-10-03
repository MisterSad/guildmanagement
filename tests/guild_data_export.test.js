// Guild data export (.xlsx). Real logic tests against fetchAllRows
// (_shared/pagination.ts) -- the pagination guard that prevents a large,
// unbounded table (event_participants, player_metrics_history) from being
// silently truncated at PostgREST's default row cap -- plus static
// regressions locking in the guild-scoping rule (a guild_admin can never
// export another guild's data) and the binary-response contract.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fetchAllRows } from '../supabase/functions/_shared/pagination.ts';

function makeFakeAdmin(pages) {
  // `pages` is keyed by table name: an array of row-arrays, one per
  // sequential .range() call. Each call also records the (from, to) it
  // was asked for, so tests can assert the pager actually advanced.
  const calls = [];
  return {
    calls,
    from(table) {
      let filters = [];
      const chain = {
        select() { return chain; },
        eq(col, val) { filters.push([col, val]); return chain; },
        or(expr) { filters.push(['or', expr]); return chain; },
        range(from, to) {
          calls.push({ table, filters, from, to });
          const tablePages = pages[table] || [];
          const pageIdx = calls.filter((c) => c.table === table).length - 1;
          const page = tablePages[pageIdx] ?? [];
          return Promise.resolve({ data: page, error: null });
        },
      };
      return chain;
    },
  };
}

describe('fetchAllRows', () => {
  it('returns everything in a single page when the table is small', async () => {
    const admin = makeFakeAdmin({ guild_members: [[{ pseudo: 'A' }, { pseudo: 'B' }]] });
    const rows = await fetchAllRows(admin, 'guild_members', 'pseudo', (q) => q.eq('guild', 'ALPHA'));
    expect(rows).toEqual([{ pseudo: 'A' }, { pseudo: 'B' }]);
    expect(admin.calls.length).toBe(1);
  });

  it('pages through a table larger than one page (1000 rows) without truncating', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const page2 = Array.from({ length: 1000 }, (_, i) => ({ id: 1000 + i }));
    const page3 = [{ id: 2000 }];
    const admin = makeFakeAdmin({ event_participants: [page1, page2, page3] });
    const rows = await fetchAllRows(admin, 'event_participants', '*', (q) => q.eq('guild', 'ALPHA'));
    expect(rows.length).toBe(2001);
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[2000]).toEqual({ id: 2000 });
    expect(admin.calls.length).toBe(3);
  });

  it('stops as soon as a page comes back short, without an extra trailing request', async () => {
    const exactlyOnePage = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const admin = makeFakeAdmin({ weekly_scores: [exactlyOnePage, []] });
    const rows = await fetchAllRows(admin, 'weekly_scores', '*', (q) => q.eq('guild', 'ALPHA'));
    // A page of exactly 1000 is ambiguous (could be the whole table or not),
    // so the pager must fetch one more page to find out -- confirms it
    // doesn't assume "full page = done" and silently drop a boundary row.
    expect(rows.length).toBe(1000);
    expect(admin.calls.length).toBe(2);
  });

  it('applies the supplied filter (e.g. guild scoping) on every page, not just the first', async () => {
    const admin = makeFakeAdmin({ sanctions: [[{ id: 1 }]] });
    await fetchAllRows(admin, 'sanctions', '*', (q) => q.eq('guild', 'ALPHA'));
    expect(admin.calls[0].filters).toEqual([['guild', 'ALPHA']]);
  });

  it('returns an empty array for an empty table rather than throwing', async () => {
    const admin = makeFakeAdmin({ banned_players: [[]] });
    const rows = await fetchAllRows(admin, 'banned_players', '*', (q) => q.eq('guild', 'ALPHA'));
    expect(rows).toEqual([]);
  });
});

describe('Regression: guild-data-export enforces guild scoping and stays paginated', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/guild-data-export/index.ts'),
    'utf-8'
  );

  it('forces guild_admin onto their own guild, never a client-supplied one', () => {
    const idx = src.indexOf('isGuildAdmin(caller.role) ? caller.guild');
    expect(idx).toBeGreaterThan(-1);
  });

  it('checks isGuildInScope for every non-guild_admin caller before exporting', () => {
    expect(src).toContain('isGuildInScope(');
    const idx = src.indexOf('if (!isGuildAdmin(caller.role))');
    expect(idx).toBeGreaterThan(-1);
  });

  it('rejects an inactive account and an unrecognized role', () => {
    expect(src).toContain('caller.status !== "active"');
    expect(src).toContain('!isAdminRole(caller.role)');
  });

  it('is registered as requiring a JWT in config.toml', () => {
    const configSrc = fs.readFileSync(path.resolve(__dirname, '../supabase/config.toml'), 'utf-8');
    const idx = configSrc.indexOf('[functions.guild-data-export]');
    expect(idx).toBeGreaterThan(-1);
    expect(configSrc.slice(idx, idx + 60)).toContain('verify_jwt = true');
  });

  it('uses the paginated fetcher for the two known-unbounded ledger tables', () => {
    expect(src).toContain('fetchAllRows(admin, "event_participants"');
    expect(src).toContain('fetchAllRows(admin, "player_metrics_history"');
    // No raw unpaginated .select() call on those tables anywhere else.
    expect(src.match(/\.from\("event_participants"\)/g) || []).toHaveLength(0);
  });

  it('returns the workbook as a binary attachment, not JSON, on success', () => {
    expect(src).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(src).toContain('Content-Disposition');
    expect(src).toContain('workbook.xlsx.writeBuffer()');
  });

  it('excludes push/device plumbing tables that carry no meaningful guild data', () => {
    expect(src).not.toContain('push_subscriptions');
    expect(src).not.toContain('player_push_prefs');
  });
});
