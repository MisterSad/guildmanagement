/**
 * Standard events (Arms Race, Defend Trade Route, Shadowfront): 30 minutes,
 * 5 minutes and start reminders, from each active event_status row.
 */

import {
  isToggleEnabled,
  resolveGuildWebhook,
  isStandardEventName,
  eventPrefixForName,
  normalizeEventName,
} from '../_shared/reminder-rules.ts';
import {
  claimSlot,
  settleSlot,
  postToDiscord,
  reminderBody,
  formatDiscordRoleMention,
  type GuildRun,
} from './shared.ts';

export interface ActiveEvent {
  guild: string;
  event_name: string;
  session_id: string;
  start_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which reminder is due `roundedMins` before the start, if any. */
function dueReminder(roundedMins: number): string {
  if (roundedMins <= 30 && roundedMins >= 25) return 'reminder_30';
  if (roundedMins <= 5 && roundedMins >= 1) return 'reminder_5';
  if (roundedMins <= 0 && roundedMins >= -5) return 'start';
  return '';
}

function roleTagFor(run: GuildRun, event: ActiveEvent, eventPrefix: string): string {
  const { config } = run;
  let eventSpecificRoleId: string | null = null;
  if (
    normalizeEventName(event.event_name) === 'SHADOWFRONT SQUAD 1' &&
    config['discord_role_id_shadowfront_squad1']?.trim()
  ) {
    eventSpecificRoleId = config['discord_role_id_shadowfront_squad1'];
  } else if (
    normalizeEventName(event.event_name) === 'SHADOWFRONT SQUAD 2' &&
    config['discord_role_id_shadowfront_squad2']?.trim()
  ) {
    eventSpecificRoleId = config['discord_role_id_shadowfront_squad2'];
  } else if (eventPrefix) {
    eventSpecificRoleId = config[`discord_role_id_${eventPrefix}`] || null;
  }
  const discordRoleId =
    eventSpecificRoleId && eventSpecificRoleId.trim() !== '' ? eventSpecificRoleId : config['discord_role_id'];
  return formatDiscordRoleMention(discordRoleId);
}

function buildMessage(
  run: GuildRun,
  event: ActiveEvent,
  eventPrefix: string,
  reminderType: string,
  eventGuildTag: string
) {
  const dateFormatted =
    new Date(event.start_at as string).toLocaleString('en-US', {
      weekday: 'short',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
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

  const { config } = run;
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

  const fields = [{ name: 'Start Time (UTC)', value: dateFormatted, inline: true }];
  if (agenda) {
    fields.push({ name: 'Guild Agenda', value: agenda, inline: false });
  }
  return reminderBody(content, embedTitle, embedDesc, color, fields);
}

export async function runStandardEvents(run: GuildRun, events: ActiveEvent[]): Promise<void> {
  const { supabase, logger, guild, config, now } = run;

  for (const event of events) {
    if (!event.start_at) continue;

    // RC5: canonical (trim + case-insensitive) name matching — a slightly
    // different label must never silently disable the 30m/5m/start reminders.
    if (!isStandardEventName(event.event_name)) continue;

    const startMs = new Date(event.start_at).getTime();

    // Auto-expire stale standard events whose start_at is older than 24 hours
    if (!isNaN(startMs) && now - startMs > DAY_MS) {
      logger.info(
        `[${guild}] Auto-expiring stale event ${event.event_name} (session: ${event.session_id}, started: ${event.start_at})`
      );
      await supabase
        .from('event_status')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('guild', guild)
        .eq('event_name', event.event_name)
        .eq('session_id', event.session_id);
      continue;
    }

    const eventPrefix = eventPrefixForName(event.event_name);
    const reminderType = dueReminder(Math.round((startMs - now) / 60000));
    if (!reminderType || !eventPrefix) continue;

    if (!isToggleEnabled(config, `notify_${eventPrefix}_${reminderType}`)) {
      logger.info(
        `[${guild}] Notification for ${event.event_name} (${reminderType}) is disabled in configuration, skipping.`
      );
      continue;
    }

    const webhookUrl = resolveGuildWebhook(config, eventPrefix);
    const lockKey = `sent_event_${event.event_name.replace(/\s+/g, '_')}_${event.session_id}_${reminderType}`;
    const what = `standard event ${event.event_name} (${reminderType})`;
    if (!(await claimSlot(run, lockKey, what))) continue;

    const body = buildMessage(run, event, eventPrefix, reminderType, roleTagFor(run, event, eventPrefix));
    const sent = await postToDiscord(run, webhookUrl, body, `${event.event_name} (${reminderType})`);
    await settleSlot(run, lockKey, sent, { event: event.event_name, type: reminderType }, what);
  }
}
