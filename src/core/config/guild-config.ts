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
import { defaultCoeffConfigEntries } from './event-coeffs';

/** Default value table used when neither the DB nor localStorage has a value. */
export const LOCAL_CONFIG_FALLBACK: Record<string, string> = {
  // B1: spread from the single declaration in ./event-coeffs, which the stats
  // engine reads too. These were five hand-written strings that duplicated it.
  ...defaultCoeffConfigEntries(),
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

/*
 * FINDING H2: `DEFAULT_GUILD_TAGS` used to live here -- a hardcoded table of 7
 * tags for a product with 26 tenants, in direct violation of ADR-003. It is
 * gone, and no seeding migration was needed: `guild_config` already holds a
 * `guild_tag` for all 7, and for 14 of the other 19 besides.
 *
 * Two of the hardcoded values were also simply WRONG -- the database says CLAW
 * is `[BYE]` and DEMO is `DEMO`, against `[CLAW]` and `[DEMO]` in the table.
 * Since the DB is read first, the real values already won; the dead table was
 * only ever consulted for a guild with no stored tag, where it now yields the
 * same `[<ID>]` the other 19 guilds have always shown.
 */

function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * Reads one config key: DB → localStorage → fallback table (or '').
 *
 * H2: `guild` may be passed explicitly. It used to be impossible to read
 * another tenant's config, because this always used `getActiveGuild()` -- which
 * is why `getGuildTag('CLAW')` returned the ACTIVE guild's tag while only its
 * fallback honoured the argument. With no guild resolvable, the static fallback
 * is returned without touching the database or localStorage: a key of
 * `gm_config_null_<key>` is not a cache, it is a bug waiting to be read back.
 */
export async function getGuildConfig(key: string, guild?: string | null): Promise<any> {
  const currentG = guild || getActiveGuild();
  if (!currentG) {
    return LOCAL_CONFIG_FALLBACK[key] !== undefined ? LOCAL_CONFIG_FALLBACK[key] : '';
  }
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
export async function setGuildConfig(key: string, value: any, guild?: string | null): Promise<boolean> {
  const currentG = guild || getActiveGuild();
  // H2: refuse rather than write config into a guessed tenant. Returning false
  // is already the contract callers use to surface a failed persist.
  if (!currentG) {
    console.error(`[guild-config] Refusing to persist "${key}": no guild resolved.`);
    return false;
  }
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

/**
 * Returns the guild tag wrapped in brackets, derived from the guild id when the
 * tenant has not configured one.
 *
 * H2: the `guild` argument is now actually honoured for the lookup, not just for
 * the fallback, and an unresolvable guild yields '' rather than ALPHA's tag.
 * Callers treat '' as "no tag configured", which is the truth.
 */
export async function getGuildTag(guild?: string | null): Promise<string> {
  const g = guild || getActiveGuild();
  if (!g) return '';
  try {
    const customTag = await getGuildConfig('guild_tag', g);
    if (customTag && typeof customTag === 'string' && customTag.trim()) {
      const t = customTag.trim();
      if (!t.startsWith('[') && !t.endsWith(']')) return '[' + t + ']';
      return t;
    }
  } catch (_) { /* fall through to the derived form */ }
  return '[' + g + ']';
}

/** Legacy `GM.config` shaped facade. */
export const config = { get: getGuildConfig, set: setGuildConfig };
export default config;
