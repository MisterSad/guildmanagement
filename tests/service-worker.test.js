/**
 * Service Worker Modernization Tests
 *
 * Covers the TypeScript port of the legacy root `sw.js`:
 *  - `src/sw/push-payload.ts` pure parser (unit tests, no SW global needed).
 *  - `src/sw/service-worker.ts` static contract: the four push listeners exist
 *    and no `fetch` handler / Cache Storage usage was introduced.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parsePushPayload,
  DEFAULT_PUSH_TITLE,
  DEFAULT_PUSH_TAG,
  DEFAULT_PUSH_URL,
} from '../src/sw/push-payload';

const rootDir = path.resolve(__dirname, '..');

function dataFrom(payload) {
  return {
    json: () => payload,
    text: () => String(payload),
  };
}

function malformedData(text) {
  return {
    json: () => { throw new SyntaxError('bad json'); },
    text: () => text,
  };
}

describe('parsePushPayload', () => {
  it('reads every field from a nominal JSON payload', () => {
    expect(parsePushPayload(dataFrom({
      title: 'SvS starts now',
      body: 'Round 1 in 5 minutes',
      tag: 'fgf-svs',
      url: '/portal',
    }))).toEqual({
      title: 'SvS starts now',
      body: 'Round 1 in 5 minutes',
      tag: 'fgf-svs',
      url: '/portal',
    });
  });

  it('falls back to the raw text body when JSON is malformed', () => {
    expect(parsePushPayload(malformedData('plain text reminder'))).toEqual({
      title: DEFAULT_PUSH_TITLE,
      body: 'plain text reminder',
      tag: DEFAULT_PUSH_TAG,
      url: DEFAULT_PUSH_URL,
    });
  });

  it('applies defaults for an empty JSON object', () => {
    expect(parsePushPayload(dataFrom({}))).toEqual({
      title: DEFAULT_PUSH_TITLE,
      body: '',
      tag: DEFAULT_PUSH_TAG,
      url: DEFAULT_PUSH_URL,
    });
  });

  it('applies defaults when there is no payload at all', () => {
    expect(parsePushPayload(null)).toEqual({
      title: DEFAULT_PUSH_TITLE,
      body: '',
      tag: DEFAULT_PUSH_TAG,
      url: DEFAULT_PUSH_URL,
    });
    expect(parsePushPayload(undefined)).toEqual({
      title: DEFAULT_PUSH_TITLE,
      body: '',
      tag: DEFAULT_PUSH_TAG,
      url: DEFAULT_PUSH_URL,
    });
  });

  it('treats empty strings and non-object JSON as absent', () => {
    expect(parsePushPayload(dataFrom({ title: '', body: '', tag: '', url: '' }))).toEqual({
      title: DEFAULT_PUSH_TITLE,
      body: '',
      tag: DEFAULT_PUSH_TAG,
      url: DEFAULT_PUSH_URL,
    });
    expect(parsePushPayload(dataFrom(null))).toEqual({
      title: DEFAULT_PUSH_TITLE,
      body: '',
      tag: DEFAULT_PUSH_TAG,
      url: DEFAULT_PUSH_URL,
    });
  });
});

describe('service-worker.ts static contract', () => {
  const sourcePath = path.join(rootDir, 'src/sw/service-worker.ts');
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('listens for install, activate, push and notificationclick', () => {
    expect(code).toContain("addEventListener('install'");
    expect(code).toContain("addEventListener('activate'");
    expect(code).toContain("addEventListener('push'");
    expect(code).toContain("addEventListener('notificationclick'");
  });

  it('registers no fetch handler', () => {
    expect(code).not.toContain("addEventListener('fetch'");
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it('never touches the Cache Storage API', () => {
    expect(code).not.toMatch(/\bcaches\b/);
    expect(code).not.toMatch(/CacheStorage/);
  });
});