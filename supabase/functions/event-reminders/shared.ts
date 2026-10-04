/**
 * supabase/functions/event-reminders/shared.ts
 *
 * What every reminder block of the cron needs: the per-guild run context, the
 * sent_* slot lock (claim, then settle), the Discord sender, and the weekly
 * clock arithmetic. Each block -- standard.ts, gvg-daily.ts, gvg-saturday.ts,
 * svs.ts, calamity.ts -- only decides WHEN to post and WHAT to say.
 */

import type { EdgeLogger } from '../_shared/logger.ts';
import type { AdminClient } from '../_shared/db.ts';

export type Config = Record<string, string>;

/** One guild, during one cron tick. */
export interface GuildRun {
  supabase: AdminClient;
  logger: EdgeLogger;
  guild: string;
  config: Config;
  /** updated_at of each sent_* lock row, for stale-lock detection. */
  lockTimes: Record<string, string>;
  now: number;
  forceGvg: boolean;
  /** What was sent, returned to the caller. */
  results: unknown[];
}

// Only the guild_config keys this function actually reads are fetched. The
// previous unfiltered SELECT pulled every template/toggle/role for every guild
// on every tick, and its row count grew with the sent_* lock rows.
const EVENT_PREFIXES = ['armsrace', 'dtr', 'shadowfront'] as const;
const REMINDER_TYPES = ['reminder_30', 'reminder_5', 'start'] as const;
const GVG_ACTIONS = ['start', 'reminder'] as const;
const SVS_ACTIONS = [
  'garrison',
  'reminder_30_invasion',
  'reminder_30_defense',
  'reminder_5_invasion',
  'reminder_5_defense',
  'start_invasion',
  'start_defense',
] as const;

export const STATIC_CONFIG_KEYS: string[] = [
  'discord_webhook_url',
  'discord_role_id',
  'discord_role_id_gvg',
  'discord_role_id_svs',
  'discord_role_id_calamity',
  'discord_role_id_shadowfront_squad1',
  'discord_role_id_shadowfront_squad2',
  'notify_gvg_daily_tasks',
  'notify_gvg_pvp',
  'notify_svs_garrison',
  'notify_svs_pvp',
  'notify_svs_won_prep',
  'notify_calamity_10',
  'webhook_gvg',
  'webhook_svs',
  'webhook_calamity',
  ...EVENT_PREFIXES.flatMap((prefix) => [
    `webhook_${prefix}`,
    `discord_role_id_${prefix}`,
    ...REMINDER_TYPES.flatMap((type) => [
      `notify_${prefix}_${type}`,
      `tpl_${prefix}_${type}_content`,
      `tpl_${prefix}_${type}_title`,
      `tpl_${prefix}_${type}_desc`,
    ]),
  ]),
  ...GVG_ACTIONS.flatMap((action) => [
    `tpl_gvg_${action}_content`,
    `tpl_gvg_${action}_title`,
    `tpl_gvg_${action}_desc`,
  ]),
  ...SVS_ACTIONS.flatMap((action) => [
    `tpl_svs_${action}_content`,
    `tpl_svs_${action}_title`,
    `tpl_svs_${action}_desc`,
  ]),
  'tpl_calamity_reminder_10_content',
  'tpl_calamity_reminder_10_title',
  'tpl_calamity_reminder_10_desc',
];

// ── Slot locks ───────────────────────────────────────────────────────────────

// Acquire a sent_* reminder lock without ever raising a unique violation:
// ON CONFLICT DO NOTHING (ignoreDuplicates) returns no row when another
// invocation already holds the guild_config (guild, key) lock, which we treat
// as "already claimed".
async function acquireReminderLock(run: GuildRun, lockKey: string): Promise<boolean> {
  const { data, error } = await run.supabase
    .from('guild_config')
    .upsert(
      { guild: run.guild, key: lockKey, value: 'sending', updated_at: new Date().toISOString() },
      { onConflict: 'guild,key', ignoreDuplicates: true }
    )
    .select('key');

  if (error) {
    run.logger.error(`[${run.guild}] Error acquiring reminder lock ${lockKey}`, error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function releaseLock(run: GuildRun, lockKey: string): Promise<void> {
  await run.supabase.from('guild_config').delete().eq('guild', run.guild).eq('key', lockKey);
}

/**
 * Claims the slot `lockKey` for this tick. A slot already 'sent' is skipped; a
 * 'sending' lock younger than 5 minutes belongs to a concurrent tick; an older
 * one is a crashed tick's, and is cleared and retried. `force` (the ?force=gvg
 * replay) ignores what the lock row says, but still takes the lock.
 */
export async function claimSlot(run: GuildRun, lockKey: string, what: string, force = false): Promise<boolean> {
  const state = run.config[lockKey];
  if (!force && state === 'sent') return false;
  if (!force && state === 'sending') {
    const updatedStr = run.lockTimes[lockKey];
    const lockAgeMins = updatedStr ? (run.now - new Date(updatedStr).getTime()) / 60000 : 999;
    if (lockAgeMins < 5) return false;
    run.logger.info(
      `[${run.guild}] Stale sending lock detected for ${lockKey} (age: ${lockAgeMins.toFixed(1)} mins). Cleaning up and retrying.`
    );
    await releaseLock(run, lockKey);
  }
  if (!(await acquireReminderLock(run, lockKey))) {
    run.logger.info(`[${run.guild}] Lock already exists for ${what}, skipping`);
    return false;
  }
  return true;
}

/** Marks a claimed slot 'sent', or releases it so the next tick retries. */
export async function settleSlot(
  run: GuildRun,
  lockKey: string,
  sent: boolean,
  result: Record<string, unknown>,
  what: string
): Promise<void> {
  if (sent) {
    try {
      await run.supabase
        .from('guild_config')
        .update({ value: 'sent', updated_at: new Date().toISOString() })
        .eq('guild', run.guild)
        .eq('key', lockKey);
    } catch (dbErr) {
      run.logger.error(`[${run.guild}] Error updating reminder lock ${lockKey}`, dbErr);
    }
    run.results.push({ guild: run.guild, ...result, status: 'sent' });
  } else {
    try {
      await releaseLock(run, lockKey);
    } catch (dbErr) {
      run.logger.error(`[${run.guild}] Error releasing reminder lock ${lockKey}`, dbErr);
    }
    run.logger.error(`[${run.guild}] Failed to send ${what}. Lock released.`);
  }
}

/** A block threw after claiming its slot: release it, so the next tick retries. */
export async function abandonSlot(run: GuildRun, lockKey: string, what: string, e: unknown): Promise<void> {
  run.logger.error(`[${run.guild}] Error sending Discord ${what} webhook`, e);
  await releaseLock(run, lockKey);
}

// ── Discord ──────────────────────────────────────────────────────────────────

function isValidDiscordWebhook(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.replace(/^[<"'\s]+|[>'"\s]+$/g, '').trim();
  try {
    const u = new URL(cleanUrl.startsWith('http') ? cleanUrl : 'https://' + cleanUrl);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'discord.com' ||
        u.hostname === 'discordapp.com' ||
        u.hostname.endsWith('.discord.com') ||
        u.hostname.endsWith('.discordapp.com')) &&
      u.pathname.includes('/webhooks/')
    );
  } catch {
    return false;
  }
}

function maskWebhookUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/(https:\/\/discord\.com\/api\/webhooks\/\d+\/)[^?#\s]+/, '$1***');
}

async function sendDiscordWebhookWithRetry(logger: EdgeLogger, url: string, body: unknown): Promise<boolean> {
  if (!isValidDiscordWebhook(url)) {
    logger.error(`SECURITY: Invalid or untrusted Discord Webhook URL blocked: ${maskWebhookUrl(url)}`);
    return false;
  }
  let attempts = 0;
  const maxAttempts = 3;
  let delay = 500; // 500ms initial backoff

  while (attempts < maxAttempts) {
    attempts++;
    try {
      logger.info(`Sending Discord webhook attempt ${attempts} to: ${maskWebhookUrl(url)}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        return true;
      }

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        let waitMs = 1000;
        if (retryAfterHeader) {
          const parsed = parseFloat(retryAfterHeader);
          if (!isNaN(parsed)) {
            waitMs = parsed < 120 ? parsed * 1000 : parsed;
          }
        }
        logger.warn(`Discord Rate Limit (429) hit. Waiting ${waitMs}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (res.status >= 500) {
        logger.warn(`Discord server error (${res.status}). Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff
        continue;
      }

      logger.error(`Discord webhook failed with non-retriable status: ${res.status}`);
      return false;
    } catch (err: any) {
      logger.error(`Network error sending Discord webhook: ${err.message}. Retrying in ${delay}ms...`, err);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  return false;
}

/** Posts to the guild's resolved webhook; an unset webhook is a skipped send. */
export async function postToDiscord(run: GuildRun, webhookUrl: string, body: unknown, what: string): Promise<boolean> {
  if (webhookUrl && webhookUrl.trim() !== '') {
    return await sendDiscordWebhookWithRetry(run.logger, webhookUrl, body);
  }
  run.logger.warn(`[${run.guild}] No Discord webhook configured for ${what} — skipping`);
  return false;
}

/** The embed every reminder posts. */
export function reminderBody(content: string, title: string, description: string, color: number, fields: unknown[]) {
  return {
    content,
    embeds: [
      {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: 'FGF Guild Management Tool' },
      },
    ],
    allowed_mentions: { parse: ['roles', 'users', 'everyone'] },
  };
}

export function formatDiscordRoleMention(input: string | undefined | null): string {
  if (!input || typeof input !== 'string') return '@everyone';
  const str = input.trim();
  if (!str || str === '@everyone') return '@everyone';
  if (str === '@here') return '@here';
  const match = str.match(/\d{15,22}/);
  if (match) return `<@&${match[0]}>`;
  if (str.startsWith('<@&') && str.endsWith('>')) return str;
  return str;
}

/** `<@&role>` for the block's own role, else the guild's, else @everyone. */
export function blockRoleTag(config: Config, roleKey: string): { roleId: string | undefined; tag: string } {
  const specific = config[roleKey];
  const roleId = specific && specific.trim() !== '' ? specific : config['discord_role_id'];
  const tag = roleId && roleId.trim() !== '' ? `<@&${roleId.trim()}>` : '@everyone';
  return { roleId, tag };
}

// ── Weekly clock ─────────────────────────────────────────────────────────────

export function getMinutesDiff(
  curDay: number,
  curHour: number,
  curMin: number,
  targetDay: number,
  targetHour: number,
  targetMin: number
): number {
  const curWeeklyMins = curDay * 1440 + curHour * 60 + curMin;
  const targetWeeklyMins = targetDay * 1440 + targetHour * 60 + targetMin;
  let diff = curWeeklyMins - targetWeeklyMins;
  // Normalize difference to [-5040, 5040] to handle weekly rollover
  diff = ((diff + 10080 + 5040) % 10080) - 5040;
  return diff;
}

export function getSlotDateString(now: number, slotDay: number): string {
  const d = new Date(now);
  const curDay = d.getUTCDay();
  let dayDiff = slotDay - curDay;
  // Normalize to closest day in the weekly cycle (-3 to 3)
  if (dayDiff > 3) dayDiff -= 7;
  else if (dayDiff < -3) dayDiff += 7;

  d.setUTCDate(d.getUTCDate() + dayDiff);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

export interface WeeklySlot {
  day: number;
  hour: number;
  minute: number;
}

/** The slots of a weekly schedule that fell in the last 10 minutes. */
export function dueSlots<T extends WeeklySlot>(now: number, schedule: T[]): T[] {
  const d = new Date(now);
  return schedule.filter((slot) => {
    const diff = getMinutesDiff(d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes(), slot.day, slot.hour, slot.minute);
    return diff >= 0 && diff <= 10;
  });
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
