/**
 * tests/reminder_rules.test.js
 *
 * Behavioral unit tests for the pure shared reminder rules used by the
 * event-reminders Edge Function (P0 audit — ghost reminders):
 *
 * RC1/RC2 — isToggleEnabled: a toggle is ONLY enabled by the literal strings
 *   'true' / '1'. Absent, '', 'false', '0' (or any other value) -> defaultState
 *   (false for every notify_* option). The old tests
 *   `config[key] === undefined || config[key] === 'true'` defaulted missing
 *   rows to ON, which re-enabled notifications daily after a silent save
 *   failure removed nothing from the DB.
 * RC3 — resolveGuildWebhook: a category whose specific webhook key is present
 *   but empty ('' -> admin cleared it) is SILENCED; the general
 *   discord_webhook_url fallback only applies when the key was never set.
 */

import { describe, it, expect } from 'vitest';
import { isToggleEnabled, resolveGuildWebhook } from '../supabase/functions/_shared/reminder-rules';

describe('isToggleEnabled (strict notify_* toggles)', () => {
  it('returns true only for the literal strings true / 1', () => {
    expect(isToggleEnabled({ k: 'true' }, 'k')).toBe(true);
    expect(isToggleEnabled({ k: '1' }, 'k')).toBe(true);
  });

  it('returns the default (false) for false, 0, empty, whitespace and other values', () => {
    expect(isToggleEnabled({ k: 'false' }, 'k')).toBe(false);
    expect(isToggleEnabled({ k: '0' }, 'k')).toBe(false);
    expect(isToggleEnabled({ k: '' }, 'k')).toBe(false);
    expect(isToggleEnabled({ k: ' TRUE ' }, 'k')).toBe(false);
    expect(isToggleEnabled({ k: 'something' }, 'k')).toBe(false);
  });

  it('returns false for a missing key or a missing config (RC1: absence is NOT enabled)', () => {
    expect(isToggleEnabled({}, 'never_written')).toBe(false);
    expect(isToggleEnabled(undefined, 'notify_gvg_daily_tasks')).toBe(false);
  });

  it('honors a non-default defaultState when the key is missing', () => {
    expect(isToggleEnabled({}, 'x', true)).toBe(true);
  });

  it('is type-strict: a real boolean or number is never treated as enabled', () => {
    expect(isToggleEnabled({ k: true }, 'k')).toBe(false);
    expect(isToggleEnabled({ k: 1 }, 'k')).toBe(false);
  });
});

describe('resolveGuildWebhook (robust fallback to general webhook & other categories)', () => {
  const GENERAL = 'https://discord.com/api/webhooks/111/aaa';
  const ARMS = 'https://discord.com/api/webhooks/333/ccc';

  it('uses a configured category webhook trimmed', () => {
    expect(resolveGuildWebhook({ 'webhook_gvg': '  https://discord.com/api/webhooks/222/bbb  ', discord_webhook_url: GENERAL }, 'gvg'))
      .toBe('https://discord.com/api/webhooks/222/bbb');
  });

  it('falls back to the general webhook when specific webhook is empty or whitespace', () => {
    expect(resolveGuildWebhook({ 'webhook_gvg': '', discord_webhook_url: GENERAL }, 'gvg')).toBe(GENERAL);
    expect(resolveGuildWebhook({ 'webhook_svs': '   ', discord_webhook_url: GENERAL }, 'svs')).toBe(GENERAL);
  });

  it('falls back to the general webhook when the category key was never configured', () => {
    expect(resolveGuildWebhook({ discord_webhook_url: GENERAL }, 'gvg')).toBe(GENERAL);
  });

  it('falls back to other category webhooks when general is not set', () => {
    expect(resolveGuildWebhook({ webhook_armsrace: ARMS }, 'gvg')).toBe(ARMS);
  });

  it('returns an empty string when nothing is configured', () => {
    expect(resolveGuildWebhook({}, 'gvg')).toBe('');
    expect(resolveGuildWebhook(undefined, 'gvg')).toBe('');
  });

  it('returns the general webhook directly for an empty prefix', () => {
    expect(resolveGuildWebhook({ 'webhook_gvg': '', discord_webhook_url: GENERAL }, '')).toBe(GENERAL);
  });
});