// Regression guard for two live production bugs found and fixed 2026-09-02:
//
// 1. Web Push: sendNotification (web-push-neo) takes 3 positional args
//    (subscription, payload, options), but the code called it with a single
//    {subscription, payload, vapidDetails} object -- so subscription.endpoint
//    was undefined and EVERY Web Push send failed, for every subscription
//    (confirmed live: 10/10 valid subscriptions all failing the same way).
//
// 2. Duplicate Discord notifications: the per-guild "lock" used to prevent
//    sending the same reminder twice used .upsert(), which never errors on
//    a primary-key conflict (guild_config's real PK is (guild, key)) -- it
//    just silently overwrites. A slow invocation overlapping with the next
//    minute's cron tick meant both read a stale "no lock yet" snapshot and
//    both sent. Confirmed live: 6 consecutive cron ticks (00:01-00:06 UTC)
//    all timed out the same morning 6 duplicate GvG Day 3 messages were
//    reported. Switched to a real .insert() so a genuine PK conflict raises
//    an error every "already claimed" retry correctly detects.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const filePath = path.resolve(__dirname, '../supabase/functions/event-reminders/index.ts');
const content = fs.readFileSync(filePath, 'utf-8');

describe('event-reminders: Web Push call signature', () => {
  it('calls sendNotification with 3 positional arguments, not a single wrapper object', () => {
    expect(content).toContain('await sendNotification(subscription, JSON.stringify(payload), { vapidDetails });');
    // The old broken shape must not reappear.
    expect(content).not.toMatch(/sendNotification\(\{\s*subscription,/);
  });
});

describe('event-reminders: reminder locks are atomic (insert, not upsert)', () => {
  it('never uses .upsert() to acquire a guild_config send-lock', () => {
    // guild_config's real PK is (guild, key) -- upsert silently overwrites
    // on conflict instead of erroring, defeating the "already locked" check.
    expect(content).not.toContain('.upsert({ guild: guild, key: lockKey');
  });

  it('every lock-acquisition site uses a real insert that can conflict', () => {
    const matches = content.match(/\.insert\(\{ guild: guild, key: lockKey, value: 'sending'/g) || [];
    // Standard events, GvG daily tasks, GvG Saturday, SvS, Calamity -- 5 sites.
    expect(matches.length).toBe(5);
  });

  it('the GvG daily task lock treats an insert conflict as "already sent" and skips, rather than silently doing nothing', () => {
    const idx = content.indexOf('Lock already exists for GvG Daily Tasks Day');
    expect(idx).toBeGreaterThan(-1);
    const before = content.slice(Math.max(0, idx - 200), idx);
    expect(before).toContain('if (lockErr) {');
  });
});
