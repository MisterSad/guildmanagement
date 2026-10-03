import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2"
import { GVG_DAILY_TASKS, buildGvgDailyTaskEmbed } from "../_shared/gvg-tasks.ts"
import { isToggleEnabled, resolveGuildWebhook, isStandardEventName, isSvsEventName, eventPrefixForName, normalizeEventName, isSvsActiveForWeek } from "../_shared/reminder-rules.ts"
import { EdgeLogger } from "../_shared/logger.ts"
import { getCorsHeaders } from "../_shared/cors.ts"

let logger = new EdgeLogger("event-reminders");

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

const STATIC_CONFIG_KEYS: string[] = [
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

// Acquire a sent_* reminder lock without ever raising a unique violation:
// ON CONFLICT DO NOTHING (ignoreDuplicates) returns no row when another
// invocation already holds the guild_config (guild, key) lock, which we treat
// as "already claimed".
async function acquireReminderLock(supabase: any, guild: string, lockKey: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('guild_config')
    .upsert(
      { guild, key: lockKey, value: 'sending', updated_at: new Date().toISOString() },
      { onConflict: 'guild,key', ignoreDuplicates: true }
    )
    .select('key');

  if (error) {
    logger.error(`[${guild}] Error acquiring reminder lock ${lockKey}`, error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// PWA Web Push decommissioned per user request: all notifications are now routed to Discord exclusively.

function isValidDiscordWebhook(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.replace(/^[<"'\s]+|[>'"\s]+$/g, '').trim();
  try {
    const u = new URL(cleanUrl.startsWith('http') ? cleanUrl : 'https://' + cleanUrl);
    return u.protocol === 'https:' &&
      (u.hostname === 'discord.com' || u.hostname === 'discordapp.com' || u.hostname.endsWith('.discord.com') || u.hostname.endsWith('.discordapp.com')) &&
      u.pathname.includes('/webhooks/');
  } catch { return false; }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function maskWebhookUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/(https:\/\/discord\.com\/api\/webhooks\/\d+\/)[^?#\s]+/, '$1***');
}

async function sendDiscordWebhookWithRetry(url: string, body: any): Promise<boolean> {
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
        signal: AbortSignal.timeout(8000)
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
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (res.status >= 500) {
        logger.warn(`Discord server error (${res.status}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff
        continue;
      }

      logger.error(`Discord webhook failed with non-retriable status: ${res.status}`);
      return false;

    } catch (err: any) {
      logger.error(`Network error sending Discord webhook: ${err.message}. Retrying in ${delay}ms...`, err);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  return false;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function getMinutesDiff(curDay: number, curHour: number, curMin: number, targetDay: number, targetHour: number, targetMin: number): number {
  const curWeeklyMins = curDay * 1440 + curHour * 60 + curMin;
  const targetWeeklyMins = targetDay * 1440 + targetHour * 60 + targetMin;
  let diff = curWeeklyMins - targetWeeklyMins;
  // Normalize difference to [-5040, 5040] to handle weekly rollover
  diff = (diff + 10080 + 5040) % 10080 - 5040;
  return diff;
}

function getSlotDateString(now: number, slotDay: number): string {
  const d = new Date(now);
  const curDay = d.getUTCDay();
  let dayDiff = slotDay - curDay;
  // Normalize to closest day in the weekly cycle (-3 to 3)
  if (dayDiff > 3) dayDiff -= 7;
  else if (dayDiff < -3) dayDiff += 7;
  
  d.setUTCDate(d.getUTCDate() + dayDiff);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getWeekStart(date: Date | string | number): string {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
}

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

serve(async (req) => {
  const json = makeJson(req);
  logger = new EdgeLogger("event-reminders", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });

  const authHeader = req.headers.get('Authorization') || '';
  const xCronSecret = req.headers.get('x-cron-secret') || '';
  const cronSecret = Deno.env.get('CRON_SECRET');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const reqUrl = new URL(req.url);
  const forceGvg = reqUrl.searchParams.get('force') === 'gvg' || reqUrl.searchParams.get('force') === 'all';
  const targetGuildParam = reqUrl.searchParams.get('guild');

  const authBearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  // Machine callers only: the pg_cron job (gm_invoke_event_reminders, which
  // sends x-cron-secret) and the service role. A user JWT used to be accepted
  // too, and without `guild` it ran -- and with `force` re-sent -- every
  // guild's reminders: any guild_admin could trigger a cross-tenant run at will
  // (audit SEC-06). Nothing in the app ever called it that way.
  const isAuthorized =
    (!!cronSecret && (safeEqual(authBearer, cronSecret) || safeEqual(xCronSecret, cronSecret))) ||
    (!!serviceRoleKey && safeEqual(authBearer, serviceRoleKey));

  if (!isAuthorized) {
    logger.warn('Unauthorized invocation of event-reminders', { hasAuth: !authHeader, hasXCron: !xCronSecret });
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    // 0. Fetch all active guilds dynamically (all guilds are Unlimited / free)
    const { data: guildRows, error: guildError } = await supabase
      .from('guilds')
      .select('id');
    if (guildError) throw guildError;
    const rawGuilds = (guildRows || []).map((r: any) => r.id);

    const GUILDS = targetGuildParam
      ? rawGuilds.filter((g: string) => g.toUpperCase() === targetGuildParam.toUpperCase())
      : rawGuilds;

    // 1. Fetch all active scheduled events across all guilds
    const { data: allEvents, error: eventError } = await supabase
      .from('event_status')
      .select('guild, event_name, session_id, start_at')
      .eq('is_active', true);

    if (eventError) throw eventError;

    // 2. Fetch only the guild_config rows this function needs: the known
    //    static keys, plus recent sent_* lock rows (bounded to the last 8
    //    days -- every reminder key embeds a date or session id, and slots
    //    recur weekly at most, so older locks can never match a live slot).
    const lockCutoffIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const configRows: any[] = [];
    if (GUILDS.length > 0) {
      const [staticRes, lockRes] = await Promise.all([
        supabase
          .from('guild_config')
          .select('guild, key, value, updated_at')
          .in('guild', GUILDS)
          .in('key', STATIC_CONFIG_KEYS),
        supabase
          .from('guild_config')
          .select('guild, key, value, updated_at')
          .in('guild', GUILDS)
          .like('key', 'sent_%')
          .gte('updated_at', lockCutoffIso),
      ]);

      if (staticRes.error) throw staticRes.error;
      if (lockRes.error) throw lockRes.error;
      configRows.push(...(staticRes.data || []), ...(lockRes.data || []));
    }

    // Group configuration by guild
    const configsByGuild: Record<string, Record<string, string>> = {};
    const lockTimes: Record<string, Record<string, string>> = {};
    for (const g of GUILDS) {
      configsByGuild[g] = {};
      lockTimes[g] = {};
    }
    for (const row of configRows) {
      if (!row.guild) continue;
      const g = row.guild;
      if (configsByGuild[g]) {
        configsByGuild[g][row.key] = row.value;
        lockTimes[g][row.key] = row.updated_at || '';
      }
    }

    // RC6: durable SvS war_sessions rows per guild — calendar-week fallback so
    // weekly SvS reminders keep firing even when the live event_status.start_at
    // is stale or missing. Single batched query before the guild loop.
    const svsWarByGuild: Record<string, Array<number | null>> = {};
    if (GUILDS.length > 0) {
      const wsRes = await supabase
        .from('war_sessions')
        .select('guild, start_at')
        .in('guild', GUILDS)
        .eq('event_name', 'SvS');
      if (wsRes.error) throw wsRes.error;
      for (const row of wsRes.data || []) {
        if (!row || !row.guild) continue;
        const ms = row.start_at ? new Date(row.start_at).getTime() : null;
        (svsWarByGuild[row.guild] ||= []).push(Number.isNaN(ms as number) ? null : ms);
      }
    }

    const now = Date.now();
    const results: any[] = [];

    // FIX (A11): formatDiscordRoleMention defined here, outside all loops
    function formatDiscordRoleMention(input: string | undefined | null): string {
      if (!input || typeof input !== 'string') return '@everyone';
      const str = input.trim();
      if (!str || str === '@everyone') return '@everyone';
      if (str === '@here') return '@here';
      const match = str.match(/\d{15,22}/);
      if (match) return `<@&${match[0]}>`;
      if (str.startsWith('<@&') && str.endsWith('>')) return str;
      return str;
    }

    // Loop through each guild tenant
    for (const guild of GUILDS) {
      const config = configsByGuild[guild];
      const events = (allEvents || []).filter((e: any) => e.guild === guild);

      // Check standard events with a start_at time
      for (const event of events) {
        if (!event.start_at) continue;

        // RC5: canonical (trim + case-insensitive) name matching — a slightly
        // different label must never silently disable the 30m/5m/start reminders.
        if (!isStandardEventName(event.event_name)) continue;

        const startMs = new Date(event.start_at).getTime();

        // Auto-expire stale standard events whose start_at is older than 24 hours
        if (!isNaN(startMs) && (now - startMs) > 24 * 60 * 60 * 1000) {
          logger.info(`[${guild}] Auto-expiring stale event ${event.event_name} (session: ${event.session_id}, started: ${event.start_at})`);
          await supabase
            .from('event_status')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('guild', guild)
            .eq('event_name', event.event_name)
            .eq('session_id', event.session_id);
          continue;
        }

        // FIX (A11): formatDiscordRoleMention moved outside the loop — was being redefined on every iteration.
        const eventPrefix = eventPrefixForName(event.event_name);

        let eventSpecificRoleId: string | null = null;
        if (normalizeEventName(event.event_name) === 'SHADOWFRONT SQUAD 1' && config['discord_role_id_shadowfront_squad1']?.trim()) {
          eventSpecificRoleId = config['discord_role_id_shadowfront_squad1'];
        } else if (normalizeEventName(event.event_name) === 'SHADOWFRONT SQUAD 2' && config['discord_role_id_shadowfront_squad2']?.trim()) {
          eventSpecificRoleId = config['discord_role_id_shadowfront_squad2'];
        } else if (eventPrefix) {
          eventSpecificRoleId = config[`discord_role_id_${eventPrefix}`] || null;
        }

        const globalRoleId = config['discord_role_id'];
        const discordRoleId = (eventSpecificRoleId && eventSpecificRoleId.trim() !== '')
          ? eventSpecificRoleId
          : globalRoleId;
        const eventGuildTag = formatDiscordRoleMention(discordRoleId);

        const diffMs = startMs - now;
        const diffMins = diffMs / 60000;
        const roundedMins = Math.round(diffMins);

        let trigger = false;
        let reminderType = '';

        if (roundedMins <= 30 && roundedMins >= 25) {
          trigger = true;
          reminderType = 'reminder_30';
        } else if (roundedMins <= 5 && roundedMins >= 1) {
          trigger = true;
          reminderType = 'reminder_5';
        } else if (roundedMins <= 0 && roundedMins >= -5) {
          trigger = true;
          reminderType = 'start';
        }

        if (trigger) {
          // Check configuration toggle
          const eventPrefix = eventPrefixForName(event.event_name);

          if (eventPrefix) {
            const configKey = `notify_${eventPrefix}_${reminderType}`;
            const isNotificationEnabled = isToggleEnabled(config, configKey);
            if (!isNotificationEnabled) {
              logger.info(`[${guild}] Notification for ${event.event_name} (${reminderType}) is disabled in configuration, skipping.`);
              continue;
            }

            const webhookUrl = resolveGuildWebhook(config, eventPrefix);
            const lockKey = `sent_event_${event.event_name.replace(/\s+/g, '_')}_${event.session_id}_${reminderType}`;

            // Fast-path memory check with stale lock handling
            if (config[lockKey] === 'sent') {
              continue;
            }
            if (config[lockKey] === 'sending') {
              const updatedStr = lockTimes[guild]?.[lockKey];
              const lockAgeMins = updatedStr ? (now - new Date(updatedStr).getTime()) / 60000 : 999;
              if (lockAgeMins < 5) {
                // Not stale yet, skip
                continue;
              }
              logger.info(`[${guild}] Stale sending lock detected for ${lockKey} (age: ${lockAgeMins.toFixed(1)} mins). Cleaning up and retrying.`);
              await supabase
                .from('guild_config')
                .delete()
                .eq('guild', guild)
                .eq('key', lockKey);
            }

            // Claim the lock atomically. ON CONFLICT DO NOTHING never raises
            // the old PK violation, and no returned row means a concurrent
            // invocation already holds it.
            const lockAcquired = await acquireReminderLock(supabase, guild, lockKey);
            if (!lockAcquired) {
              logger.info(`[${guild}] Lock already exists for standard event ${event.event_name} (${reminderType}), skipping`);
              continue;
            }

            let sentSuccess = false;
            const dateFormatted = new Date(event.start_at).toLocaleString('en-US', {
              weekday: 'short', month: '2-digit', day: '2-digit', timeZone: 'UTC',
              hour: '2-digit', minute: '2-digit', hour12: false
            }) + ' UTC';



            let content = '';
            let embedTitle = `📢 Guild Event: ${event.event_name}`;
            let embedDesc = 'A guild event has been configured in the FGF Guild Management tool!';
            let color = 5763719; // Green
            let agenda = 'Please connect now.';

            if (reminderType === 'reminder_30') {
              content = `⏰ **Reminder:** ${event.event_name} starts in **30 minutes**! ${eventGuildTag}`;
              embedTitle = `⏰ Reminder: ${event.event_name} starts in 30 minutes!`;
              embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
              color = 16750848; // Orange
              agenda = 'Please connect and get ready soon.';
            } else if (reminderType === 'reminder_5') {
              content = `🚨 **Immediate Reminder:** ${event.event_name} starts in **5 minutes**! Get ready! ${eventGuildTag}`;
              embedTitle = `🚨 Immediate Reminder: ${event.event_name} starts in 5 minutes!`;
              embedDesc = 'Action time! Join your squad now!';
              color = 15548997; // Bright Red
              agenda = 'Action time! Connect now!';
            } else if (reminderType === 'start') {
              content = `⚔️ **Event Started:** ${event.event_name} starts now! ${eventGuildTag}`;
              embedTitle = `⚔️ Event Started: ${event.event_name} is active!`;
              embedDesc = 'Action time! Join your squad now!';
              color = 15548997; // Bright Red
              agenda = 'Battle starts now! Join your squad!';
            }

            const customContent = config[`tpl_${eventPrefix}_${reminderType}_content`];
            const customTitle = config[`tpl_${eventPrefix}_${reminderType}_title`];
            const customDesc = config[`tpl_${eventPrefix}_${reminderType}_desc`];

            const replacePlaceholders = (str: string) => {
              if (!str) return str;
              return str
                .replace(/@{guild_tag}/g, '{guild_tag}')
                .replace(/{event_name}/g, event.event_name)
                .replace(/{date}/g, dateFormatted)
                .replace(/{guild_tag}/g, eventGuildTag)
                .replace(/<@(\d{15,22})>/g, '<@&$1>')
                .replace(/(^|\s)@(\d{15,22})($|\s)/g, '$1<@&$2>$3');
            };

            if (customContent && customContent.trim() !== '') content = replacePlaceholders(customContent);
            if (customTitle && customTitle.trim() !== '') embedTitle = replacePlaceholders(customTitle);
            if (customDesc && customDesc.trim() !== '') {
              embedDesc = replacePlaceholders(customDesc);
              agenda = '';
            }

            const fields = [
              { name: 'Start Time (UTC)', value: dateFormatted, inline: true }
            ];
            if (agenda) {
              fields.push({ name: 'Guild Agenda', value: agenda, inline: false });
            }

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'FGF Guild Management Tool' }
              }],
              allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
            };

            if (webhookUrl && webhookUrl.trim() !== '') {
              sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
            } else {
              logger.warn(`[${guild}] No Discord webhook configured for ${event.event_name} (${reminderType}) — skipping`);
              sentSuccess = false;
            }

            if (sentSuccess) {
              try {
                await supabase
                  .from('guild_config')
                  .update({ value: 'sent', updated_at: new Date().toISOString() })
                  .eq('guild', guild)
                  .eq('key', lockKey);
              } catch (dbErr) {
                logger.error(`[${guild}] Error updating standard event lock ${lockKey}`, dbErr);
              }
              results.push({ guild, event: event.event_name, type: reminderType, status: 'sent' });
            } else {
              try {
                await supabase
                  .from('guild_config')
                  .delete()
                  .eq('guild', guild)
                  .eq('key', lockKey);
              } catch (dbErr) {
                logger.error(`[${guild}] Error releasing standard event lock ${lockKey}`, dbErr);
              }
              logger.error(`[${guild}] Failed to send standard event ${event.event_name} reminder. Lock released.`);
            }
          }
        }
      }

      // 3. GvG Daily Tasks & Saturday notifications
      const eventSpecificRoleId = config['discord_role_id_gvg'];
      const discordRoleId = (eventSpecificRoleId && eventSpecificRoleId.trim() !== '')
        ? eventSpecificRoleId
        : config['discord_role_id'];
      const gvgGuildTag = (discordRoleId && discordRoleId.trim() !== '')
        ? `<@&${discordRoleId.trim()}>`
        : '@everyone';

      // 3.1. GvG Daily Task Reminders (Monday to Saturday at 00:01 UTC)
      const isGvgDailyTasksEnabled = isToggleEnabled(config, 'notify_gvg_daily_tasks');
      const webhookUrlGvg = resolveGuildWebhook(config, 'gvg');

      if (isGvgDailyTasksEnabled && webhookUrlGvg !== '') {
        const dateUtc = new Date(now);
        const curDay = dateUtc.getUTCDay(); // 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
        const curHour = dateUtc.getUTCHours();
        const curMin = dateUtc.getUTCMinutes();

        // Monday (1) to Saturday (6)
        if (curDay >= 1 && curDay <= 6) {
          const diff = getMinutesDiff(curDay, curHour, curMin, curDay, 0, 1);
          const shouldRunSlot = (diff >= 0 && diff <= 6) || forceGvg;

          if (shouldRunSlot) {
            const slotDate = dateUtc.toISOString().split('T')[0];
            const lockKey = `sent_gvg_daily_tasks_day_${curDay}_${slotDate}_00:01`;

            let shouldProceed = true;
            if (!forceGvg && config[lockKey] === 'sent') {
              shouldProceed = false;
            } else if (!forceGvg && config[lockKey] === 'sending') {
              const updatedStr = lockTimes[guild]?.[lockKey];
              const lockAgeMins = updatedStr ? (now - new Date(updatedStr).getTime()) / 60000 : 999;
              if (lockAgeMins < 5) {
                shouldProceed = false;
              } else {
                logger.info(`[${guild}] Stale sending lock detected for ${lockKey} (age: ${lockAgeMins.toFixed(1)} mins). Retrying.`);
                await supabase
                  .from('guild_config')
                  .delete()
                  .eq('guild', guild)
                  .eq('key', lockKey);
              }
            }

            if (shouldProceed) {
              const lockAcquired = await acquireReminderLock(supabase, guild, lockKey);
              if (!lockAcquired) {
                logger.info(`[${guild}] Lock already exists for GvG Daily Tasks Day ${curDay}, skipping`);
              } else {
                try {
                  const roleMention = formatDiscordRoleMention(discordRoleId);
                  const baseBody = buildGvgDailyTaskEmbed(curDay, roleMention);
                  const body = {
                    ...baseBody,
                    allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
                  };
                  const sentSuccess = await sendDiscordWebhookWithRetry(webhookUrlGvg, body);

                  if (sentSuccess) {
                    const taskDay = GVG_DAILY_TASKS[curDay];
                    await supabase
                      .from('guild_config')
                      .update({ value: 'sent', updated_at: new Date().toISOString() })
                      .eq('guild', guild)
                      .eq('key', lockKey);

                    results.push({ guild, event: `GvG Daily Tasks - Day ${curDay} (${taskDay?.dayName})`, type: 'gvg_daily_tasks', status: 'sent' });
                  } else {
                    await supabase
                      .from('guild_config')
                      .delete()
                      .eq('guild', guild)
                      .eq('key', lockKey);
                    logger.error(`[${guild}] Failed to send GvG Daily Tasks webhook. Lock released.`);
                  }
                } catch (e) {
                  logger.error(`[${guild}] Error sending Discord GvG Daily Tasks webhook`, e);
                  await supabase
                    .from('guild_config')
                    .delete()
                    .eq('guild', guild)
                    .eq('key', lockKey);
                }
              }
            }
          }
        }
      }

      // 3.2. GvG Saturday War Prism and Fortress Reminders
      const isGvgPvpEnabled = isToggleEnabled(config, 'notify_gvg_pvp');
      const webhookUrlGvgSat = resolveGuildWebhook(config, 'gvg');
      if (isGvgPvpEnabled && webhookUrlGvgSat !== '') {
          const dateUtc = new Date(now);
          const curDay = dateUtc.getUTCDay();
          const curHour = dateUtc.getUTCHours();
          const curMin = dateUtc.getUTCMinutes();

          const GVG_SCHEDULE = [
            { day: 6, hour: 0, minute: 0, targetHour: 0, targetMinute: 0, label: 'War Prism', type: 'now' },
            { day: 6, hour: 1, minute: 0, targetHour: 1, targetMinute: 0, label: 'War Prism', type: 'now' },
            { day: 6, hour: 10, minute: 0, targetHour: 10, targetMinute: 0, label: 'War Fortress', type: 'now' },
            { day: 6, hour: 13, minute: 0, targetHour: 13, targetMinute: 0, label: 'War Prism', type: 'now' },
            { day: 6, hour: 14, minute: 0, targetHour: 14, targetMinute: 0, label: 'War Prism', type: 'now' },
            { day: 6, hour: 22, minute: 0, targetHour: 22, targetMinute: 0, label: 'War Fortress', type: 'now' },

            { day: 5, hour: 23, minute: 55, targetHour: 0, targetMinute: 0, label: 'War Prism', type: 'reminder' },
            { day: 6, hour: 0, minute: 55, targetHour: 1, targetMinute: 0, label: 'War Prism', type: 'reminder' },
            { day: 6, hour: 9, minute: 55, targetHour: 10, targetMinute: 0, label: 'War Fortress', type: 'reminder' },
            { day: 6, hour: 12, minute: 55, targetHour: 13, targetMinute: 0, label: 'War Prism', type: 'reminder' },
            { day: 6, hour: 13, minute: 55, targetHour: 14, targetMinute: 0, label: 'War Prism', type: 'reminder' },
            { day: 6, hour: 21, minute: 55, targetHour: 22, targetMinute: 0, label: 'War Fortress', type: 'reminder' }
          ];

          const matchingSlots = GVG_SCHEDULE.filter(slot => {
            const diff = getMinutesDiff(curDay, curHour, curMin, slot.day, slot.hour, slot.minute);
            return diff >= 0 && diff <= 10;
          });

          for (const slot of matchingSlots) {
            const slotDate = getSlotDateString(now, slot.day);
            const lockKey = `sent_gvg_${slot.label.replace(/\s+/g, '_')}_${slot.type}_${slotDate}_${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;

            // Fast-path memory check with stale lock handling
            if (config[lockKey] === 'sent') {
              continue;
            }
            if (config[lockKey] === 'sending') {
              const updatedStr = lockTimes[guild]?.[lockKey];
              const lockAgeMins = updatedStr ? (now - new Date(updatedStr).getTime()) / 60000 : 999;
              if (lockAgeMins < 5) {
                // Not stale yet, skip
                continue;
              }
              logger.info(`[${guild}] Stale sending lock detected for ${lockKey} (age: ${lockAgeMins.toFixed(1)} mins). Cleaning up and retrying.`);
              await supabase
                .from('guild_config')
                .delete()
                .eq('guild', guild)
                .eq('key', lockKey);
            }

            const lockAcquired = await acquireReminderLock(supabase, guild, lockKey);
            if (!lockAcquired) {
              logger.info(`[${guild}] Lock already exists for GvG ${slot.label} (${slot.type}), skipping`);
              continue;
            }

            try {
              let content = '';
              let embedTitle = '';
              let embedDesc = '';
              let color = 5763719;
              let agenda = '';

              if (slot.type === 'now') {
                if (slot.label === 'War Prism') {
                  content = `⚔️ **GvG: War Prism** starts now! @everyone`;
                  embedTitle = `⚔️ GvG - War Prism`;
                  embedDesc = `The War Prism event is active. Join the battle now!`;
                  color = 9807270;
                  agenda = `Secure the War Prism now.`;
                } else if (slot.label === 'War Fortress') {
                  content = `🏰 **GvG: War Fortress** starts now! @everyone`;
                  embedTitle = `🏰 GvG - War Fortress`;
                  embedDesc = `The War Fortress event is active. All units to their stations!`;
                  color = 15548997;
                  agenda = `Secure the War Fortress now.`;
                }
              } else {
                if (slot.label === 'War Prism') {
                  content = `⏰ **GvG: War Prism** starts in **5 minutes**! @everyone`;
                  embedTitle = `⏰ GvG - War Prism (Reminder)`;
                  embedDesc = `Get ready! The War Prism event starts in 5 minutes.`;
                  color = 16750848;
                  agenda = `Log in and prepare for the War Prism.`;
                } else if (slot.label === 'War Fortress') {
                  content = `⏰ **GvG: War Fortress** starts in **5 minutes**! @everyone`;
                  embedTitle = `⏰ GvG - War Fortress (Reminder)`;
                  embedDesc = `Get ready! The War Fortress event starts in 5 minutes.`;
                  color = 16750848;
                  agenda = `Log in and prepare for the War Fortress.`;
                }
              }

              const startHourStr = String(slot.targetHour).padStart(2, '0');
              const startMinStr = String(slot.targetMinute).padStart(2, '0');
              const timeStr = `${startHourStr}:${startMinStr} UTC`;

              const gvgAction = slot.type === 'now' ? 'start' : 'reminder';
              const customContent = config[`tpl_gvg_${gvgAction}_content`];
              const customTitle = config[`tpl_gvg_${gvgAction}_title`];
              const customDesc = config[`tpl_gvg_${gvgAction}_desc`];

              const replacePlaceholders = (str: string) => {
                if (!str) return str;
                return str
                  .replace(/{event_name}/g, slot.label)
                  .replace(/{date}/g, timeStr)
                  .replace(/{guild_tag}/g, gvgGuildTag);
              };

              if (customContent && customContent.trim() !== '') content = replacePlaceholders(customContent);
              if (customTitle && customTitle.trim() !== '') embedTitle = replacePlaceholders(customTitle);
              if (customDesc && customDesc.trim() !== '') {
                embedDesc = replacePlaceholders(customDesc);
                agenda = '';
              }

              const fields = [
                { name: 'Start Time (UTC)', value: timeStr, inline: true }
              ];
              if (agenda) {
                fields.push({ name: 'Guild Agenda', value: agenda, inline: false });
              }

              const body = {
                content: content,
                embeds: [{
                  title: embedTitle,
                  description: embedDesc,
                  color: color,
                  fields: fields,
                  timestamp: new Date().toISOString(),
                  footer: { text: 'FGF Guild Management Tool' }
                }],
                allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
              };

              const webhookUrl = webhookUrlGvgSat;
              let sentSuccess = false;
              if (webhookUrl && webhookUrl.trim() !== '') {
                sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
              } else {
                logger.warn(`[${guild}] No Discord webhook configured for GvG Saturday ${slot.label} — skipping`);
                sentSuccess = false;
              }

              if (sentSuccess) {
                await supabase
                  .from('guild_config')
                  .update({ value: 'sent', updated_at: new Date().toISOString() })
                  .eq('guild', guild)
                  .eq('key', lockKey);

                results.push({ guild, event: `GvG Saturday - ${slot.label} (${slot.type})`, type: 'gvg_saturday', status: 'sent' });
              } else {
                await supabase
                  .from('guild_config')
                  .delete()
                  .eq('guild', guild)
                  .eq('key', lockKey);
                logger.error(`[${guild}] Failed to send GvG Saturday reminder. Lock released.`);
              }
            } catch (e) {
              logger.error(`[${guild}] Error sending Discord GvG Saturday webhook`, e);
              await supabase
                .from('guild_config')
                .delete()
                .eq('guild', guild)
                .eq('key', lockKey);
            }
          }
        }

      // 4. SvS notifications and reminders
      // RC6: the session is active when it belongs to the current UTC calendar
      // week — either an active event_status SvS row whose start_at falls in the
      // week (or has no start_at), or a durable war_sessions SvS row of the
      // week. The legacy 7.5-day sliding window silently killed weekly SvS
      // reminders mid-cycle and is gone.
      const svsEvent = events.find(e => isSvsEventName(e.event_name));
      const isSvsActive = isSvsActiveForWeek(now, {
        eventActive: !!svsEvent,
        eventStartAtMs: svsEvent && svsEvent.start_at ? new Date(svsEvent.start_at).getTime() : null,
        warSessionTimestampsMs: svsWarByGuild[guild] || [],
      });
      if (isSvsActive) {
        const eventSpecificRoleId = config['discord_role_id_svs'];
        const discordRoleId = (eventSpecificRoleId && eventSpecificRoleId.trim() !== '')
          ? eventSpecificRoleId
          : config['discord_role_id'];
        const svsGuildTag = (discordRoleId && discordRoleId.trim() !== '')
          ? `<@&${discordRoleId.trim()}>`
          : '@everyone';

        const dateUtc = new Date(now);
        const curDay = dateUtc.getUTCDay();
        const curHour = dateUtc.getUTCHours();
        const curMin = dateUtc.getUTCMinutes();

        const SVS_SCHEDULE = [
          { day: 5, hour: 20, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
          { day: 5, hour: 21, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
          { day: 5, hour: 22, minute: 0, label: 'Garrison Reminder', type: 'garrison' },

          { day: 5, hour: 23, minute: 55, label: 'Portal Reminder 5m', type: 'portal_5' },
          { day: 6, hour: 0, minute: 0, label: 'Portal Open', type: 'portal_open' },

          { day: 6, hour: 13, minute: 30, label: 'Battle Reminder 30m', type: 'reminder_30' },
          { day: 6, hour: 13, minute: 55, label: 'Battle Reminder 5m', type: 'reminder_5' },
          { day: 6, hour: 14, minute: 0, label: 'Battle Start', type: 'battle_start' }
        ];

        const matchingSlots = SVS_SCHEDULE.filter(slot => {
          const diff = getMinutesDiff(curDay, curHour, curMin, slot.day, slot.hour, slot.minute);
          return diff >= 0 && diff <= 10;
        });

        for (const slot of matchingSlots) {
          // Check configuration toggle
          if (slot.type === 'portal_5' || slot.type === 'portal_open') {
            // RC7: portal battle notifications are detached from won_prep — only
            // notify_svs_pvp gates them. notify_svs_won_prep remains a pure
            // content switch (invasion vs defense wording) further below.
            const isSvsPvpEnabled = isToggleEnabled(config, 'notify_svs_pvp');
            if (!isSvsPvpEnabled) {
              logger.info(`[${guild}] SvS Portal notification (${slot.type}) skipped (PvP disabled).`);
              continue;
            }
          } else if (slot.type === 'garrison') {
            const isGarrisonEnabled = isToggleEnabled(config, 'notify_svs_garrison');
            if (!isGarrisonEnabled) {
              logger.info(`[${guild}] SvS Garrison Reminder is disabled in configuration, skipping.`);
              continue;
            }
          } else {
            const isSvsPvpEnabled = isToggleEnabled(config, 'notify_svs_pvp');
            if (!isSvsPvpEnabled) {
              logger.info(`[${guild}] SvS PvP Day notification (${slot.type}) is disabled in configuration, skipping.`);
              continue;
            }
          }

          const slotDate = getSlotDateString(now, slot.day);
          const lockKey = `sent_svs_${slot.label.replace(/\s+/g, '_')}_${slot.type}_${slotDate}_${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;

          // Fast-path memory check with stale lock handling
          if (config[lockKey] === 'sent') {
            continue;
          }
          if (config[lockKey] === 'sending') {
            const updatedStr = lockTimes[guild]?.[lockKey];
            const lockAgeMins = updatedStr ? (now - new Date(updatedStr).getTime()) / 60000 : 999;
            if (lockAgeMins < 5) {
              // Not stale yet, skip
              continue;
            }
            logger.info(`[${guild}] Stale sending lock detected for ${lockKey} (age: ${lockAgeMins.toFixed(1)} mins). Cleaning up and retrying.`);
            await supabase
              .from('guild_config')
              .delete()
              .eq('guild', guild)
              .eq('key', lockKey);
          }

          const lockAcquired = await acquireReminderLock(supabase, guild, lockKey);
          if (!lockAcquired) {
            logger.info(`[${guild}] Lock already exists for SvS ${slot.label} (${slot.type}), skipping`);
            continue;
          }

          try {
            let content = '';
            let embedTitle = '';
            let embedDesc = '';
            let color = 5763719;
            let agenda = '';
            let fields: any[] = [];

            if (slot.type === 'garrison') {
              content = `🛡️ **SvS: Garrison Reminder** - Don't forget to put your ships in garrison to avoid being attacked while offline! ${svsGuildTag || '@everyone'}`;
              embedTitle = `🛡️ SvS: Garrison Reminder`;
              embedDesc = `Protect your ships before going offline.`;
              color = 3447003;
              agenda = `Put your ships in garrison.`;
              fields = [
                { name: 'Time (UTC)', value: `${String(curHour).padStart(2, '0')}:00 UTC`, inline: true },
                { name: 'Guild Agenda', value: agenda, inline: false }
              ];
            } else {
              let timeStr = '14:00 UTC';
              if (slot.type === 'portal_5' || slot.type === 'portal_open') {
                timeStr = '00:00 UTC';
              }
              const wonPrep = isToggleEnabled(config, 'notify_svs_won_prep');
              
              if (slot.type === 'portal_5') {
                content = `⏰ **SvS: Invasion Portal opens in 5 minutes! Prepare to cross!** @everyone`;
                embedTitle = `⏰ SvS: Invasion Portal (5m Reminder)`;
                embedDesc = `The portal to the enemy server will open in 5 minutes. Get ready to jump!`;
                color = 16750848;
                agenda = `Prepare your fleets. Reminder: cargo attacks are forbidden!`;
              } else if (slot.type === 'portal_open') {
                content = `⚔️ **SvS: Invasion Portal is Open! Attack!** @everyone`;
                embedTitle = `⚔️ SvS: Invasion Portal Open!`;
                embedDesc = `The portal to the enemy server is now open. Time to jump and attack target players! Reminder: cargo ships are strictly off-limits!`;
                color = 15548997;
                agenda = `Jump to the enemy server and conquer!`;
              } else if (slot.type === 'reminder_30') {
                if (wonPrep) {
                  content = `⏰ **SvS: Invasion starts in 30 minutes! Prepare to attack!** @everyone`;
                  embedTitle = `⏰ SvS: Invasion starts in 30 minutes`;
                  embedDesc = `We won the preparation! We are invading the enemy server. Attack is authorized, but remember: DO NOT attack cargo ships (forbidden)! All other targets are permitted.`;
                  agenda = `Log in and prepare your attack fleets. Save your drones for the main battle at 14:00 UTC (don't lose them early)!`;
                } else {
                  content = `⏰ **SvS: Defense starts in 30 minutes! Protect yourself and prepare to defend the Blackhole!** @everyone`;
                  embedTitle = `⏰ SvS: Defense starts in 30 minutes`;
                  embedDesc = `We are being invaded. Please put all your ships in garrison now. If garrison is not possible, UNEQUIP your drones to avoid losing them in attacks!`;
                  agenda = `Garrison ships, unequip drones if needed, and log in to prepare for the Blackhole defense starting at 14:00 UTC.`;
                }
                color = 16750848;
              } else if (slot.type === 'reminder_5') {
                if (wonPrep) {
                  content = `🚨 **SvS: Invasion starts in 5 minutes! Join attack squads!** @everyone`;
                  embedTitle = `🚨 SvS: Invasion starts in 5 minutes!`;
                  embedDesc = `Portal opens in 5 minutes! Ready to jump and attack. Keep drones safe until the main battle, and remember cargo ships are off-limits!`;
                  agenda = `Join your squads and prepare to jump to the enemy server.`;
                } else {
                  content = `🚨 **SvS: Defense starts in 5 minutes! Ready your squads!** @everyone`;
                  embedTitle = `🚨 SvS: Defense starts in 5 minutes!`;
                  embedDesc = `Invasion is imminent. Make sure your home assets are safe (garrison/unequip drones) and join defense squads!`;
                  agenda = `Join defense squads now. Guard the Blackhole!`;
                }
                color = 15548997;
              } else if (slot.type === 'battle_start') {
                if (wonPrep) {
                  content = `⚔️ **SvS: Invasion has started! Go attack!** @everyone`;
                  embedTitle = `⚔️ SvS: Invasion has started!`;
                  embedDesc = `The invasion portal is open! Jump to the enemy server and conquer. Attacks on cargos are FORBIDDEN; all other targets are allowed. Save your drones for key clashes!`;
                  agenda = `Invade and destroy the enemy! Good luck!`;
                } else {
                  content = `⚔️ **SvS: Blackhole Defense has started! Protect the server!** @everyone`;
                  embedTitle = `⚔️ SvS: Defense has started!`;
                  embedDesc = `Enemy forces are entering our server! Defend the Blackhole at all costs. Ensure no ships are exposed without garrison unless actively fighting.`;
                  agenda = `Defend the Blackhole! Repel the invaders!`;
                }
                color = 15548997;
              }

              fields = [
                { name: 'Start Time (UTC)', value: timeStr, inline: true },
                { name: 'Guild Agenda', value: agenda, inline: false }
              ];
            }

            let actionSuffix = '';
            const wonPrepVal = isToggleEnabled(config, 'notify_svs_won_prep');
            if (slot.type === 'reminder_30') {
              actionSuffix = wonPrepVal ? 'reminder_30_invasion' : 'reminder_30_defense';
            } else if (slot.type === 'reminder_5') {
              actionSuffix = wonPrepVal ? 'reminder_5_invasion' : 'reminder_5_defense';
            } else if (slot.type === 'battle_start') {
              actionSuffix = wonPrepVal ? 'start_invasion' : 'start_defense';
            } else if (slot.type === 'garrison') {
              actionSuffix = 'garrison';
            }

            if (actionSuffix) {
              const customContent = config[`tpl_svs_${actionSuffix}_content`];
              const customTitle = config[`tpl_svs_${actionSuffix}_title`];
              const customDesc = config[`tpl_svs_${actionSuffix}_desc`];

              const timeVal = slot.type === 'garrison' ? `${String(slot.hour).padStart(2, '0')}:00 UTC` : (slot.type === 'portal_5' || slot.type === 'portal_open' ? '00:00 UTC' : '14:00 UTC');

              const replacePlaceholders = (str: string) => {
                if (!str) return str;
                return str
                  .replace(/{event_name}/g, 'SvS')
                  .replace(/{date}/g, timeVal)
                  .replace(/{guild_tag}/g, svsGuildTag);
              };

              if (customContent && customContent.trim() !== '') content = replacePlaceholders(customContent);
              if (customTitle && customTitle.trim() !== '') embedTitle = replacePlaceholders(customTitle);
              if (customDesc && customDesc.trim() !== '') {
                embedDesc = replacePlaceholders(customDesc);
                fields = [
                  { name: 'Time (UTC)', value: timeVal, inline: true }
                ];
              }
            }

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'FGF Guild Management Tool' }
              }],
              allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
            };

            const webhookUrl = resolveGuildWebhook(config, 'svs');
            let sentSuccess = false;
            if (webhookUrl && webhookUrl.trim() !== '') {
              sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
            } else {
              logger.warn(`[${guild}] No Discord webhook configured for SvS ${slot.label} — skipping`);
              sentSuccess = false;
            }

            if (sentSuccess) {
              await supabase
                .from('guild_config')
                .update({ value: 'sent', updated_at: new Date().toISOString() })
                .eq('guild', guild)
                .eq('key', lockKey);

              results.push({ guild, event: `SvS - ${slot.label}`, type: `svs_${slot.type}`, status: 'sent' });
            } else {
              await supabase
                .from('guild_config')
                .delete()
                .eq('guild', guild)
                .eq('key', lockKey);
              logger.error(`[${guild}] Failed to send SvS reminder. Lock released.`);
            }
          } catch (e) {
            logger.error(`[${guild}] Error sending Discord SvS webhook`, e);
            await supabase
              .from('guild_config')
              .delete()
              .eq('guild', guild)
              .eq('key', lockKey);
          }
        }
      }

      // 5. Calamity Befalls weekly reminders (10m before round)
      const calamityRoleId = config['discord_role_id_calamity'];
      const calamityDiscordRoleId = (calamityRoleId && calamityRoleId.trim() !== '')
        ? calamityRoleId
        : config['discord_role_id'];
      const calamityGuildTag = (calamityDiscordRoleId && calamityDiscordRoleId.trim() !== '')
        ? `<@&${calamityDiscordRoleId.trim()}>`
        : '@everyone';

        const dateUtc = new Date(now);
        const curDay = dateUtc.getUTCDay();
        const curHour = dateUtc.getUTCHours();
        const curMin = dateUtc.getUTCMinutes();

        const CALAMITY_SCHEDULE = [
          { day: 1, hour: 23, minute: 50, round: 1, targetHour: 0, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 2, minute: 50, round: 2, targetHour: 3, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 5, minute: 50, round: 3, targetHour: 6, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 8, minute: 50, round: 4, targetHour: 9, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 11, minute: 50, round: 5, targetHour: 12, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 14, minute: 50, round: 6, targetHour: 15, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 17, minute: 50, round: 7, targetHour: 18, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 20, minute: 50, round: 8, targetHour: 21, targetMinute: 0, targetDay: 'Tuesday' },
          { day: 2, hour: 23, minute: 50, round: 9, targetHour: 0, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 2, minute: 50, round: 10, targetHour: 3, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 5, minute: 50, round: 11, targetHour: 6, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 8, minute: 50, round: 12, targetHour: 9, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 11, minute: 50, round: 13, targetHour: 12, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 14, minute: 50, round: 14, targetHour: 15, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 17, minute: 50, round: 15, targetHour: 18, targetMinute: 0, targetDay: 'Wednesday' },
          { day: 3, hour: 20, minute: 50, round: 16, targetHour: 21, targetMinute: 0, targetDay: 'Wednesday' }
        ];

        const matchingSlots = CALAMITY_SCHEDULE.filter(slot => {
          const diff = getMinutesDiff(curDay, curHour, curMin, slot.day, slot.hour, slot.minute);
          return diff >= 0 && diff <= 10;
        });

        for (const slot of matchingSlots) {
          // Check configuration toggle
          const isCalamityEnabled = isToggleEnabled(config, 'notify_calamity_10');
          if (!isCalamityEnabled) {
            logger.info(`[${guild}] Calamity Befalls Round reminders are disabled in configuration, skipping.`);
            continue;
          }

          const slotDate = getSlotDateString(now, slot.day);
          const lockKey = `sent_calamity_round_${slot.round}_${slotDate}`;

          // Fast-path memory check with stale lock handling
          if (config[lockKey] === 'sent') {
            continue;
          }
          if (config[lockKey] === 'sending') {
            const updatedStr = lockTimes[guild]?.[lockKey];
            const lockAgeMins = updatedStr ? (now - new Date(updatedStr).getTime()) / 60000 : 999;
            if (lockAgeMins < 5) {
              // Not stale yet, skip
              continue;
            }
            logger.info(`[${guild}] Stale sending lock detected for ${lockKey} (age: ${lockAgeMins.toFixed(1)} mins). Cleaning up and retrying.`);
            await supabase
              .from('guild_config')
              .delete()
              .eq('guild', guild)
              .eq('key', lockKey);
          }

          const lockAcquired = await acquireReminderLock(supabase, guild, lockKey);
          if (!lockAcquired) {
            logger.info(`[${guild}] Lock already exists for Calamity Round ${slot.round}, skipping`);
            continue;
          }

          try {
            let content = `⏰ **Calamity Befalls: Round ${slot.round} starts in 10 minutes!**`;
            let embedTitle = `⏰ Calamity Befalls - Round ${slot.round} (Reminder)`;
            let embedDesc = `Prepare your squads! Calamity Befalls Round ${slot.round} starts in 10 minutes.`;
            const color = 16750848;
            let agenda = 'Log in and prepare for the battle.';

            const startHourStr = String(slot.targetHour).padStart(2, '0');
            const startMinStr = String(slot.targetMinute).padStart(2, '0');
            const timeStr = `${slot.targetDay} · ${startHourStr}:${startMinStr} UTC`;



            const customContent = config[`tpl_calamity_reminder_10_content`];
            const customTitle = config[`tpl_calamity_reminder_10_title`];
            const customDesc = config[`tpl_calamity_reminder_10_desc`];

            const replacePlaceholders = (str: string) => {
              if (!str) return str;
              return str
                .replace(/{event_name}/g, 'Calamity Befalls')
                .replace(/{date}/g, timeStr)
                .replace(/{round}/g, String(slot.round))
                .replace(/{guild_tag}/g, calamityGuildTag);
            };

            if (customContent && customContent.trim() !== '') content = replacePlaceholders(customContent);
            if (customTitle && customTitle.trim() !== '') embedTitle = replacePlaceholders(customTitle);
            if (customDesc && customDesc.trim() !== '') {
              embedDesc = replacePlaceholders(customDesc);
              agenda = '';
            }

            const fields = [
              { name: 'Round', value: `${slot.round} / 16`, inline: true },
              { name: 'Start Time (UTC)', value: timeStr, inline: true }
            ];
            if (agenda) {
              fields.push({ name: 'Guild Agenda', value: agenda, inline: false });
            }

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'FGF Guild Management Tool' }
              }],
              allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
            };

            const webhookUrl = resolveGuildWebhook(config, 'calamity');
            let sentSuccess = false;
            if (webhookUrl && webhookUrl.trim() !== '') {
              sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
            } else {
              logger.warn(`[${guild}] No Discord webhook configured for Calamity Round ${slot.round} — skipping`);
              sentSuccess = false;
            }

            if (sentSuccess) {
              await supabase
                .from('guild_config')
                .update({ value: 'sent', updated_at: new Date().toISOString() })
                .eq('guild', guild)
                .eq('key', lockKey);

              results.push({ guild, event: `Calamity Befalls - Round ${slot.round}`, type: 'calamity_befalls', status: 'sent' });
            } else {
              await supabase
                .from('guild_config')
                .delete()
                .eq('guild', guild)
                .eq('key', lockKey);
              logger.error(`[${guild}] Failed to send Calamity Befalls reminder. Lock released.`);
            }
          } catch (e) {
            logger.error(`[${guild}] Error sending Discord Calamity Befalls webhook`, e);
            await supabase
              .from('guild_config')
              .delete()
              .eq('guild', guild)
              .eq('key', lockKey);
          }
        }
    }

    return json({ ok: true, processed: results }, 200);

  } catch (err: any) {
    logger.error('Event reminders execution error', err);
    return json({ error: err.message }, 500);
  }
})
