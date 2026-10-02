import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  savePendingIntent,
  peekPendingIntent,
  clearPendingIntent,
  sanitizeIntent,
  PENDING_INTENT_TTL_MS,
} from '../src/core/auth/pending-intent';

beforeEach(() => { sessionStorage.clear(); });

describe('pending intent', () => {
  it('round-trips a valid intent through sessionStorage', () => {
    savePendingIntent({ kind: 'join', code: 'FGF-7K2M-X9Q4', uid: '123456' });
    expect(peekPendingIntent()).toMatchObject({ kind: 'join', code: 'FGF-7K2M-X9Q4', uid: '123456' });
    clearPendingIntent();
    expect(peekPendingIntent()).toBeNull();
  });

  it('expires after the TTL', () => {
    const now = Date.now();
    savePendingIntent({ kind: 'code', code: 'ABCDE-FGHIJ', ts: now - PENDING_INTENT_TTL_MS - 1 });
    expect(peekPendingIntent(now)).toBeNull();
    expect(sessionStorage.getItem('gm_pending_intent')).toBeNull();
  });

  it('drops malformed values instead of pre-filling them', () => {
    const i = sanitizeIntent({ kind: 'join', code: '<script>', uid: '12a', ts: 1 });
    expect(i).toEqual({ kind: 'join', ts: 1 });
    expect(sanitizeIntent({ kind: 'admin', ts: 1 })).toBeNull();
    expect(sanitizeIntent('join')).toBeNull();
  });

  it('only keeps the fields that belong to the kind', () => {
    const i = sanitizeIntent({ kind: 'create', guildTag: 'sigma', serverNumber: '1089', uid: '1', code: 'X-1', ts: 1 });
    expect(i).toEqual({ kind: 'create', guildTag: 'SIGMA', serverNumber: '1089', ts: 1 });
  });

  it('cannot carry a password, whatever the caller passes', () => {
    savePendingIntent({ kind: 'claim', accountId: 'Hawk', password: 'hunter2' });
    expect(sessionStorage.getItem('gm_pending_intent')).not.toContain('hunter2');
  });

  it('survives a corrupt stored value', () => {
    sessionStorage.setItem('gm_pending_intent', '{not json');
    expect(peekPendingIntent()).toBeNull();
  });

  it('lives in core/ and imports nothing from modules/', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/auth/pending-intent.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*modules\//);
  });
});
