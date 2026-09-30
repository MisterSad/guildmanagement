/**
 * tests/discord_rally.test.js
 *
 * /call-to-arms kept its tally in a Map in the worker's memory, so every
 * restart lost every answer and the next click repainted the post with that
 * one click alone. The answers now live in `discord_rally_responses`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CTA_CLICK_SUFFIX, ctaSessionFromRows, ctaHeaderFromEmbed } from '../discord-verification-worker/rally.js';

describe('ctaSessionFromRows', () => {
  it('rebuilds all three lists from the stored rows', () => {
    const s = ctaSessionFromRows('SvS', null, [
      { discord_user_id: '1', status: 'present', pseudo: 'Ann', power: '1000', fleet: 5 },
      { discord_user_id: '2', status: 'late', pseudo: 'Bob', power: 0, fleet: 0 },
      { discord_user_id: '3', status: 'absent', pseudo: 'Cid', power: 0, fleet: 0 },
      { discord_user_id: '4', status: 'present', pseudo: 'Dee', power: 2000, fleet: 1 },
    ]);
    expect(s.present.size).toBe(2);
    expect(s.late.size).toBe(1);
    expect(s.absent.size).toBe(1);
    expect(s.present.get('1')).toEqual({ pseudo: 'Ann', power: 1000, fleet: 5 });
  });

  it('ignores a status it does not know', () => {
    const s = ctaSessionFromRows('SvS', null, [{ discord_user_id: '1', status: 'constructor', pseudo: 'X' }]);
    expect(s.present.size + s.late.size + s.absent.size).toBe(0);
  });
});

describe('ctaHeaderFromEmbed', () => {
  it('reads back the event name and the description it was posted with', () => {
    expect(ctaHeaderFromEmbed({ title: '⚔️ Call to Arms: SvS Saturday', description: 'Portal at 14:00' + CTA_CLICK_SUFFIX }))
      .toEqual({ eventName: 'SvS Saturday', description: 'Portal at 14:00' });
  });
  it('handles a rally posted without a description', () => {
    expect(ctaHeaderFromEmbed({ title: '⚔️ Call to Arms: GvG', description: '**Click a button below to declare your attendance for this battle:**' }))
      .toEqual({ eventName: 'GvG', description: null });
  });
});

describe('worker wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../discord-verification-worker/index.js'), 'utf-8');
  it('keeps no rally state in memory', () => {
    expect(src).not.toContain('ctaSessions');
  });
  it('records the answer, then repaints from every stored answer for that message', () => {
    const handler = src.slice(src.indexOf('async function handleCtaButton'), src.indexOf('/**\n * /mystats'));
    expect(handler).toContain('.from("discord_rally_responses")');
    expect(handler).toContain('onConflict: "message_id,discord_user_id"');
    expect(handler).toMatch(/\.eq\("message_id", messageId\)/);
    expect(handler).toContain("I couldn't record your answer");
  });
});

describe('discord_rally_responses migration', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260930130000_discord_rally_responses.sql'), 'utf-8');
  it('is service-role only: RLS forced, no policy, no API-role grant', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).toMatch(/REVOKE ALL ON public\.discord_rally_responses FROM PUBLIC, anon, authenticated;/);
  });
  it('purges answers after 7 days, as privacy.html says', () => {
    expect(sql).toMatch(/interval '7 days'/);
    const privacy = fs.readFileSync(path.resolve(__dirname, '../privacy.html'), 'utf-8');
    expect(privacy).toContain('Call-to-arms answers in Discord: 7 days');
  });
});
