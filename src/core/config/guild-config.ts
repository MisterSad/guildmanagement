/**
 * src/core/config/guild-config.ts
 *
 * Guild configuration store (port of the legacy `GM.config`): DB-first with a
 * localStorage fallback and a per-key default table. Behaviour mirrors
 * gm-utils.js#getGuildConfig / setGuildConfig / getGuildTag exactly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getClient } from '../api/supabase';
import { getActiveGuild } from '../auth/roles';

/** Default value table used when neither the DB nor localStorage has a value. */
export const LOCAL_CONFIG_FALLBACK: Record<string, string> = {
  coeff_svs: '5',
  coeff_gvg: '5',
  coeff_shadowfront: '3',
  coeff_dtr: '2',
  coeff_armsrace: '1',
  webhook_armsrace: '',
  webhook_dtr: '',
  webhook_shadowfront: '',
  webhook_calamity: '',
  webhook_gvg: '',
  webhook_svs: '',
  webhook_svs_opponent: '',
  webhook_gvg_opponent: '',
  notify_armsrace_reminder_30: 'true',
  notify_armsrace_reminder_5: 'true',
  notify_armsrace_start: 'true',
  notify_dtr_reminder_30: 'true',
  notify_dtr_reminder_5: 'true',
  notify_dtr_start: 'true',
  notify_shadowfront_reminder_30: 'true',
  notify_shadowfront_reminder_5: 'true',
  notify_shadowfront_start: 'true',
  notify_calamity_10: 'true',
  notify_gvg_daily_tasks: 'true',
  notify_gvg_pvp: 'true',
  notify_svs_garrison: 'true',
  notify_svs_pvp: 'true',
  notify_svs_won_prep: 'false'
};

const DEFAULT_GUILD_TAGS: Record<string, string> = {
  ALPHA: '[PR1M]',
  OMEGA: '[OMG]',
  BABE: '[BABE]',
  IMK: '[IMK]',
  YARR: '[YARR]',
  CLAW: '[CLAW]',
  DEMO: '[DEMO]'
};

function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/** Reads one config key: DB → localStorage → fallback table (or ''). */
export async function getGuildConfig(key: string): Promise<any> {
  const currentG = getActiveGuild();
  const c = getClient();
  if (c) {
    try {
      const res = await c.from('guild_config').select('value').eq('key', key).eq('guild', currentG).maybeSingle();
      if (res && (res as any).error) {
        console.error('guild_config select error for key ' + key + ':', (res as any).error);
      }
      if (res && (res as any).data) return (res as any).data.value;
    } catch (e) {
      console.warn('guild_config table fetch error, falling back to LocalStorage', e);
    }
  }
  const store = ls();
  const local = store ? store.getItem('gm_config_' + currentG + '_' + key) : null;
  if (local !== null) return local;
  return LOCAL_CONFIG_FALLBACK[key] !== undefined ? LOCAL_CONFIG_FALLBACK[key] : '';
}

/**
 * Writes one config key to the DB, then mirrors it to localStorage on success.
 * Returns `false` (never throwing) on any DB failure so callers can surface the
 * error instead of validating a change that never persisted. The localStorage
 * mirror is only written AFTER a successful upsert: a failed write must not
 * visually validate an unchecked notification toggle (P0 audit RC1).
 */
export async function setGuildConfig(key: string, value: any): Promise<boolean> {
  const currentG = getActiveGuild();
  const c = getClient();
  if (c) {
    try {
      const res = await c.from('guild_config').upsert(
        { guild: currentG, key: key, value: value, updated_at: new Date().toISOString() },
        { onConflict: 'guild,key' }
      );
      if (res && (res as any).error) {
        console.error(`[guild-config] Failed to persist "${key}" for guild "${currentG}":`, (res as any).error);
        return false;
      }
    } catch (e) {
      console.error(`[guild-config] Exception persisting "${key}" for guild "${currentG}":`, e);
      return false;
    }
  }
  const store = ls();
  if (store) store.setItem('gm_config_' + currentG + '_' + key, value);
  return true;
}

/** Returns the guild tag wrapped in brackets, with per-guild defaults. */
export async function getGuildTag(guild?: string): Promise<string> {
  const g = guild || getActiveGuild();
  try {
    const customTag = await getGuildConfig('guild_tag');
    if (customTag && typeof customTag === 'string' && customTag.trim()) {
      const t = customTag.trim();
      if (!t.startsWith('[') && !t.endsWith(']')) return '[' + t + ']';
      return t;
    }
  } catch (_) { /* fall through to defaults */ }
  return DEFAULT_GUILD_TAGS[g] || ('[' + (g || 'ALPHA') + ']');
}

/** Legacy `GM.config` shaped facade. */
export const config = { get: getGuildConfig, set: setGuildConfig };
export default config;
