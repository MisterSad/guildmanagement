/**
 * tests/discord_rename_only.test.js
 *
 * Rename-only channels (public.discord_channel_modes): the worker's part of the
 * flow, RUN with every dependency faked -- the live forwarder and the history
 * backfill. The Edge Function's part (no role, no roster, no message) is pinned
 * by supabase/functions/discord-profile-verification/index.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  renameOnlyChannelMap,
  imageAttachmentOf,
  forwardScreenshot,
  newerFirst,
  listChannelMessages,
  screenshotsByAuthor,
  classify,
  runBackfill,
  renameOnlySucceeded,
} from '../discord-verification-worker/rename-only.js';

const SERVER = '1525831969710014625';
const CHANNEL = '1544654496536338542';

// Snowflakes beyond 2^53, so ordering must not go through Number.
const id = (n) => (1544654496536338542n + BigInt(n)).toString();

function msg(n, userId, { image = true, bot = false } = {}) {
  return {
    id: id(n),
    author: { id: userId, username: `user${userId}`, bot },
    attachments: image ? [{ url: `https://cdn.test/${n}.png`, content_type: 'image/png' }] : [],
  };
}

function ok(nickname, extra = {}) {
  return {
    status: 200,
    result: { ok: true, mode: 'rename_only', nickname, previous_nickname: null, changed: true, ...extra },
  };
}
const err = (error, status = 200, extra = {}) => ({
  status,
  result: { ok: false, mode: 'rename_only', error, ...extra },
});

/** Runs the backfill with scripted answers per message id. */
async function backfill({ messages, answers, members = null, state = { authors: {} }, dryRun = false }) {
  const forwarded = [];
  const saves = [];
  const sleeps = [];
  const queues = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const summary = await runBackfill({
    messages,
    state,
    dryRun,
    pauseMs: 0,
    now: () => '2026-11-07T12:00:00.000Z',
    isMember: async (userId) => (members ? members.includes(userId) : true),
    forward: async (author, candidate, opts) => {
      forwarded.push({ userId: author.userId, messageId: candidate.messageId, dryRun: opts.dryRun });
      const q = queues.get(candidate.messageId);
      if (!q || q.length === 0) throw new Error(`no scripted answer for ${candidate.messageId}`);
      return q.length > 1 ? q.shift() : q[0];
    },
    sleep: async (ms) => sleeps.push(ms),
    log: () => {},
    saveState: async (s) => saves.push(JSON.parse(JSON.stringify(s))),
  });
  return { summary, forwarded, saves, sleeps, state };
}

describe('configuration', () => {
  it('maps only rename_only rows, channel -> server', () => {
    const map = renameOnlyChannelMap([
      { channel_id: CHANNEL, discord_server_id: SERVER, mode: 'rename_only' },
      { channel_id: '1', discord_server_id: '2', mode: 'something_else' },
      { channel_id: '', discord_server_id: SERVER, mode: 'rename_only' },
    ]);
    expect([...map]).toEqual([[CHANNEL, SERVER]]);
  });

  it('has no server or channel id written into the worker code', () => {
    const dir = path.resolve(__dirname, '../discord-verification-worker');
    for (const f of ['index.js', 'rename-only.js', 'backfill-rename.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toContain(SERVER);
      expect(src, f).not.toContain(CHANNEL);
    }
  });
});

describe('forwardScreenshot', () => {
  it('sends the screenshot with no guild and no mode: the Edge Function resolves the mode', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://cdn.test/a.png') return new Response(new Uint8Array([1, 2, 3]));
      return new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 });
    };
    const r = await forwardScreenshot({
      fetchImpl,
      functionUrl: 'https://fn.test/discord-profile-verification',
      secret: 's3cret',
      userId: '42',
      username: 'ace',
      serverId: SERVER,
      channelId: CHANNEL,
      attachment: { url: 'https://cdn.test/a.png', contentType: 'image/png' },
    });
    expect(r).toEqual({ status: 200, result: { ok: true, changed: true } });
    const body = JSON.parse(calls[1].init.body);
    expect(body).toEqual({
      discord_user_id: '42',
      discord_username: 'ace',
      discord_server_id: SERVER,
      channel_id: CHANNEL,
      image_base64: Buffer.from([1, 2, 3]).toString('base64'),
      mime_type: 'image/png',
    });
    expect(calls[1].init.headers.Authorization).toBe('Bearer s3cret');
  });

  it('a failed download never reaches the Edge Function', async () => {
    const calls = [];
    const r = await forwardScreenshot({
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response('gone', { status: 404 });
      },
      functionUrl: 'https://fn.test/x',
      secret: 's',
      userId: '1',
      username: 'u',
      serverId: SERVER,
      channelId: CHANNEL,
      attachment: { url: 'https://cdn.test/a.png', contentType: 'image/png' },
      dryRun: true,
    });
    expect(r.result.error).toBe('download_failed');
    expect(calls).toEqual(['https://cdn.test/a.png']);
  });

  it('reads both discord.js collections and raw REST attachments', () => {
    const collection = new Map([['1', { url: 'u', contentType: 'image/webp' }]]);
    expect(imageAttachmentOf(collection)).toEqual({ url: 'u', contentType: 'image/webp' });
    expect(imageAttachmentOf([{ url: 'v', content_type: 'text/plain' }])).toBeNull();
  });
});

describe('history', () => {
  it('orders snowflakes as integers, not as floats or strings', () => {
    expect(newerFirst('99999999999999999', '100000000000000000')).toBe(1);
    expect(newerFirst(id(2), id(1))).toBe(-1);
  });

  it('pages backwards with `before` until a short page', async () => {
    const all = Array.from({ length: 250 }, (_, i) => msg(250 - i, 'u')); // newest first
    const befores = [];
    const got = await listChannelMessages(async (before) => {
      befores.push(before);
      const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
      return all.slice(start, start + 100);
    });
    expect(got.length).toBe(250);
    expect(befores).toEqual([null, id(151), id(51)]);
  });

  it('groups screenshots per author, newest first, without bots or text messages', () => {
    const groups = screenshotsByAuthor([
      msg(1, 'a'),
      msg(5, 'a'),
      msg(3, 'b'),
      msg(9, 'b', { image: false }),
      msg(7, 'bot', { bot: true }),
    ]);
    expect(groups.map((g) => [g.userId, g.candidates.map((c) => c.messageId)])).toEqual([
      ['b', [id(3)]],
      ['a', [id(5), id(1)]],
    ]);
  });

  it('classifies every answer the Edge Function gives', () => {
    expect(classify(200, { ok: true })).toBe('done');
    expect(classify(200, { ok: false, error: 'missing_fields_in_ocr' })).toBe('invalid');
    expect(classify(200, { ok: false, error: 'member_not_found' })).toBe('left');
    expect(classify(200, { ok: false, error: 'cannot_rename' })).toBe('refused');
    expect(classify(429, { ok: false, error: 'discord_rate_limited' })).toBe('wait');
    expect(classify(429, { ok: false, error: 'rate_limited' })).toBe('deferred');
    expect(classify(502, { ok: false, error: 'ocr_failed' })).toBe('deferred');
    expect(classify(500, null)).toBe('deferred');
  });
});

describe('reaction', () => {
  it("is ✅ only when the author now carries the screenshot's name", () => {
    expect(renameOnlySucceeded({ ok: true, changed: true })).toBe(true);
    expect(renameOnlySucceeded({ ok: true, changed: false })).toBe(true);
    for (const error of ['cannot_rename', 'missing_fields_in_ocr', 'rate_limited', 'member_not_found']) {
      expect(renameOnlySucceeded({ ok: false, error }), error).toBe(false);
    }
    expect(renameOnlySucceeded(null)).toBe(false);
  });
});

describe('runBackfill', () => {
  it("uses each author's most recent VALID screenshot", async () => {
    const { summary, forwarded, state } = await backfill({
      messages: [msg(1, 'a'), msg(2, 'a'), msg(3, 'a')],
      answers: { [id(3)]: err('missing_fields_in_ocr'), [id(2)]: ok('[SB] Ace #1042'), [id(1)]: ok('old') },
    });
    expect(forwarded.map((f) => f.messageId)).toEqual([id(3), id(2)]); // never the older one
    expect(summary.renamed).toBe(1);
    // Recorded against the NEWEST message, so a re-run does not re-read the others.
    expect(state.authors.a).toEqual({
      messageId: id(3),
      outcome: 'done',
      nickname: '[SB] Ace #1042',
      at: '2026-11-07T12:00:00.000Z',
    });
  });

  it('is idempotent: a second run forwards nothing', async () => {
    const messages = [msg(1, 'a'), msg(2, 'b')];
    const answers = { [id(1)]: ok('A'), [id(2)]: ok('B') };
    const first = await backfill({ messages, answers });
    expect(first.forwarded.length).toBe(2);
    const second = await backfill({ messages, answers, state: first.state });
    expect(second.forwarded).toEqual([]);
    expect(second.summary.alreadyDone).toBe(2);
  });

  it('re-reads an author who posted a newer screenshot since the last run', async () => {
    const first = await backfill({ messages: [msg(1, 'a')], answers: { [id(1)]: ok('Old #1') } });
    const second = await backfill({
      messages: [msg(1, 'a'), msg(4, 'a')],
      answers: { [id(4)]: ok('New #1') },
      state: first.state,
    });
    expect(second.forwarded.map((f) => f.messageId)).toEqual([id(4)]);
    expect(second.state.authors.a.nickname).toBe('New #1');
  });

  it('skips members who left, before any OCR, and does not record them', async () => {
    const { summary, forwarded, state } = await backfill({
      messages: [msg(1, 'gone'), msg(2, 'here')],
      answers: { [id(2)]: ok('Here #1') },
      members: ['here'],
    });
    expect(forwarded.map((f) => f.userId)).toEqual(['here']);
    expect(summary.left).toBe(1);
    expect(state.authors.gone).toBeUndefined();
  });

  it('waits out a Discord rate limit, then retries the same screenshot', async () => {
    const { summary, forwarded, sleeps } = await backfill({
      messages: [msg(1, 'a')],
      answers: { [id(1)]: [err('discord_rate_limited', 429, { retry_after: 2.5 }), ok('A')] },
    });
    expect(forwarded.map((f) => f.messageId)).toEqual([id(1), id(1)]);
    expect(sleeps).toEqual([2500]);
    expect(summary.renamed).toBe(1);
  });

  it('defers an author on the attempt throttle and leaves them for the next run', async () => {
    const { summary, state } = await backfill({
      messages: [msg(1, 'a'), msg(2, 'a')],
      answers: { [id(2)]: err('rate_limited', 429) },
    });
    expect(summary.deferred).toBe(1);
    expect(state.authors.a).toBeUndefined();
  });

  it('records an author whose screenshots are all unreadable, and one the bot may not rename', async () => {
    const { summary, state } = await backfill({
      messages: [msg(1, 'a'), msg(2, 'owner')],
      answers: { [id(1)]: err('missing_fields_in_ocr'), [id(2)]: err('cannot_rename') },
    });
    expect([summary.invalid, summary.refused]).toEqual([1, 1]);
    expect(state.authors.a.outcome).toBe('invalid');
    expect(state.authors.owner.outcome).toBe('refused');
  });

  it('a dry run asks for dry runs, records nothing and saves nothing', async () => {
    const { summary, forwarded, saves, state } = await backfill({
      messages: [msg(1, 'a')],
      answers: { [id(1)]: ok('A', { changed: false, dry_run: true }) },
      dryRun: true,
    });
    expect(forwarded[0].dryRun).toBe(true);
    expect(summary.wouldRename).toBe(1);
    expect(saves).toEqual([]);
    expect(state.authors).toEqual({});
  });
});

describe('worker wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../discord-verification-worker/index.js'), 'utf8');
  const handler = src.slice(
    src.indexOf('async function handleRenameOnlyMessage'),
    src.indexOf('// Optional per-guild verified-role ID')
  );

  it('checks the rename-only map before the verification map', () => {
    const listener = src.slice(src.indexOf('client.on("messageCreate"'));
    expect(listener.indexOf('renameOnlyChannels.get(')).toBeGreaterThan(-1);
    expect(listener.indexOf('renameOnlyChannels.get(')).toBeLessThan(listener.indexOf('channelToGuild.get('));
  });

  it('the rename-only handler reacts ⏳ then ✅/❌, and replies, deletes and grants nothing', () => {
    expect(handler.length).toBeGreaterThan(100);
    expect(handler).toContain('addReaction(message, "⏳")');
    expect(handler).toContain('settleFeedback(message, renameOnlySucceeded(result))');
    for (const forbidden of [
      'reply(',
      '.send(',
      'delete(',
      'roles.',
      'addVerifiedRole',
      'sendVerificationDm',
      'fgf_guild',
    ]) {
      expect(handler, forbidden).not.toContain(forbidden);
    }
  });
});
