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

beforeEach(() => {
  sessionStorage.clear();
});

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

describe('shared invite links', () => {
  it('builds fragment links, never query strings', async () => {
    const { buildInviteLink } = await import('../src/core/auth/pending-intent');
    expect(buildInviteLink('https://guildmanagement.vercel.app/', 'join', 'FGF-7K2M-X9Q4')).toBe(
      'https://guildmanagement.vercel.app/#join=FGF-7K2M-X9Q4'
    );
    expect(buildInviteLink('https://x.app', 'code', 'ABCDE-FGHIJ')).toBe('https://x.app/#code=ABCDE-FGHIJ');
  });

  it('captures #join=, stores it and strips it from the URL', async () => {
    const { captureIntentFromHash } = await import('../src/core/auth/pending-intent');
    window.history.replaceState({}, '', '/?keep=1#join=FGF-7K2M-X9Q4');
    const intent = captureIntentFromHash();
    expect(intent).toMatchObject({ kind: 'join', code: 'FGF-7K2M-X9Q4', fromLink: true });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?keep=1');
    expect(peekPendingIntent()).toMatchObject({ kind: 'join', code: 'FGF-7K2M-X9Q4' });
  });

  it('strips but ignores a malformed code', async () => {
    const { captureIntentFromHash } = await import('../src/core/auth/pending-intent');
    window.history.replaceState({}, '', '/#code=%3Cscript%3E');
    expect(captureIntentFromHash()).toBeNull();
    expect(window.location.hash).toBe('');
    expect(peekPendingIntent()).toBeNull();
  });

  it('leaves unrelated fragments alone', async () => {
    const { captureIntentFromHash } = await import('../src/core/auth/pending-intent');
    window.history.replaceState({}, '', '/#terms');
    expect(captureIntentFromHash()).toBeNull();
    expect(window.location.hash).toBe('#terms');
  });
});
