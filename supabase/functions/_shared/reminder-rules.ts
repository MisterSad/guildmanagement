/**
 * supabase/functions/_shared/reminder-rules.ts
 *
 * Pure, dependency-free evaluation rules for the event-reminders Edge Function.
 * Kept free of Deno/std imports so Vitest can unit-test the exact semantics.
 *
 * P0 audit (RC1/RC2/RC3) — ghost notifications:
 * - Every notification toggle MUST be evaluated through isToggleEnabled().
 *   "Missing row" is NOT "enabled": only the literal strings 'true' / '1'
 *   enable a toggle, anything else (absent, '', 'false', '0', boolean-ish)
 *   yields defaultState (false for every notify_* option). This fixes the
 *   ghost reminders that kept firing while the Guild Admin panel showed the
 *   checkbox unchecked — the DB row was absent because the save silently
 *   failed, and the legacy `config[key] === undefined || === 'true'` tests
 *   defaulted to ON.
 * - resolveGuildWebhook(): a category whose specific webhook key is explicitly
 *   empty ('' -> user cleared it) is SILENCED and must never fall back to the
 *   general discord_webhook_url. Fallback only applies when the specific key
 *   has never been configured.
 */

export type ConfigMap = Record<string, string | undefined>;

export function isToggleEnabled(
  config: ConfigMap | Record<string, string> | undefined,
  key: string,
  defaultState = false
): boolean {
  if (!config) return defaultState;
  const raw = config[key];
  if (raw === 'true' || raw === '1') return true;
  return defaultState;
}

export function resolveGuildWebhook(configMap: ConfigMap | Record<string, string> | undefined, prefix: string): string {
  if (!configMap) return '';
  if (prefix) {
    const specific = configMap[`webhook_${prefix}`];
    if (specific !== undefined) return (specific || '').trim();
  }
  return (configMap['discord_webhook_url'] || '').trim();
}

/* ---------------------------------------------------------------------------
 * P1 (RC5) — canonical event-name matching
 *
 * Standard-event reminders used to compare raw labels ('ARMS RACE STAGE A',
 * 'Defend Trade Route', ...) verbatim. A label with different casing, leading
 * or trailing whitespace silently disabled the 30m/5m/start reminders. All
 * comparisons now go through normalizeEventName() + the canonical set below.
 * ------------------------------------------------------------------------- */

export const STANDARD_EVENT_NAMES: ReadonlySet<string> = new Set([
  'ARMS RACE STAGE A',
  'ARMS RACE STAGE B',
  'DEFEND TRADE ROUTE',
  'SHADOWFRONT SQUAD 1',
  'SHADOWFRONT SQUAD 2',
]);

/** Trim + uppercase canonical form used for every event-name comparison. */
export function normalizeEventName(name: string | null | undefined): string {
  return (name || '').trim().toUpperCase();
}

export function isStandardEventName(name: string | null | undefined): boolean {
  return STANDARD_EVENT_NAMES.has(normalizeEventName(name));
}

export function isSvsEventName(name: string | null | undefined): boolean {
  const n = normalizeEventName(name);
  return n === 'SVS' || n.startsWith('SVS ');
}

export function eventPrefixForName(name: string | null | undefined): string {
  const n = normalizeEventName(name);
  if (n.includes('ARMS RACE')) return 'armsrace';
  if (n.includes('TRADE ROUTE') || n.includes('DTR')) return 'dtr';
  if (n.includes('SHADOWFRONT')) return 'shadowfront';
  if (n.includes('CALAMITY')) return 'calamity';
  if (n.includes('GVG')) return 'gvg';
  if (n.includes('SVS')) return 'svs';
  return '';
}

/* ---------------------------------------------------------------------------
 * P1 (RC6) — SvS session detection aligned on the current calendar week
 *
 * The legacy sliding window (start_at age <= 7.5 days) silently killed weekly
 * SvS reminders mid-cycle as soon as start_at aged out. Detection is now based
 * on the UTC calendar week containing "now": an active SvS event_status row
 * whose start_at falls inside the current week (or has no start_at) is active,
 * and a durable war_sessions SvS row of the current week counts too.
 * ------------------------------------------------------------------------- */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Milliseconds since epoch of Monday 00:00:00 UTC of the week containing nowMs. */
export function utcWeekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

export function isTimestampInCurrentUtcWeek(nowMs: number, tsMs: number | null | undefined): boolean {
  if (tsMs === null || tsMs === undefined || Number.isNaN(tsMs)) return false;
  const weekStart = utcWeekStartMs(nowMs);
  return tsMs >= weekStart && tsMs < weekStart + WEEK_MS;
}

export interface SvsWeekProbe {
  /** event_status.start_at of the SvS row (ms), or null when absent. */
  eventStartAtMs: number | null;
  /** event_status SvS row exists and is active. */
  eventActive: boolean;
  /** war_sessions.start_at timestamps (ms) for this guild's SvS rows. */
  warSessionTimestampsMs: Array<number | null>;
}

export function isSvsActiveForWeek(nowMs: number, probe: SvsWeekProbe): boolean {
  if (probe.eventActive) {
    if (probe.eventStartAtMs === null || Number.isNaN(probe.eventStartAtMs)) return true;
    if (isTimestampInCurrentUtcWeek(nowMs, probe.eventStartAtMs)) return true;
  }
  if (probe.warSessionTimestampsMs && probe.warSessionTimestampsMs.length > 0) {
    if (probe.warSessionTimestampsMs.some((t) => isTimestampInCurrentUtcWeek(nowMs, t))) return true;
  }
  return false;
}