/**
 * GvG: the daily task list (Monday to Saturday at 00:01 UTC) and the Saturday
 * War Prism / War Fortress starts with their 5-minute reminders. Both fall on
 * the same Saturday as SvS, so a week is one or the other: an SvS week gets no
 * GvG reminder (ticket #14: a guild running SvS got the whole GvG week in
 * Discord), unless a GvG session of that week says otherwise. A guild that
 * never starts a war in the app keeps its GvG reminders as a weekly clock.
 */

import { GVG_DAILY_TASKS, buildGvgDailyTaskEmbed } from '../_shared/gvg-tasks.ts';
import { isToggleEnabled, resolveGuildWebhook, isGvgEventName, isWarActiveForWeek } from '../_shared/reminder-rules.ts';
import {
  claimSlot,
  settleSlot,
  abandonSlot,
  postToDiscord,
  reminderBody,
  formatDiscordRoleMention,
  blockRoleTag,
  getMinutesDiff,
  getSlotDateString,
  dueSlots,
  pad2,
  type GuildRun,
} from './shared.ts';
import type { ActiveEvent } from './standard.ts';

/**
 * Whether GvG reminders post this week: not in an SvS week, unless the week
 * also has a GvG session (an explicit GvG start outranks an SvS row that was
 * left active). `?force=gvg` does not bypass it: a forced replay never posts
 * GvG into an SvS week.
 */
export function gvgRemindersAllowed(svsWeek: boolean, gvgWeek: boolean): boolean {
  return gvgWeek || !svsWeek;
}

/**
 * Whether the guild has a GvG session in the UTC week of `now`: an active GvG
 * event_status row started this week (or with no start_at), or a GvG
 * war_sessions row of this week, so ending the session early on Saturday does
 * not cut the remaining War Fortress reminders.
 */
export function isGvgWeek(now: number, events: ActiveEvent[], warSessionTimestampsMs: Array<number | null>): boolean {
  const gvgEvent = events.find((e) => isGvgEventName(e.event_name));
  return isWarActiveForWeek(now, {
    eventActive: !!gvgEvent,
    eventStartAtMs: gvgEvent && gvgEvent.start_at ? new Date(gvgEvent.start_at).getTime() : null,
    warSessionTimestampsMs,
  });
}

export async function runGvgDailyTasks(run: GuildRun, allowed: boolean): Promise<void> {
  if (!allowed) return;
  const { config, now, forceGvg } = run;
  const webhookUrlGvg = resolveGuildWebhook(config, 'gvg');
  if (!isToggleEnabled(config, 'notify_gvg_daily_tasks') || webhookUrlGvg === '') return;

  const dateUtc = new Date(now);
  const curDay = dateUtc.getUTCDay(); // 1=Mon ... 6=Sat
  if (curDay < 1 || curDay > 6) return;

  const diff = getMinutesDiff(curDay, dateUtc.getUTCHours(), dateUtc.getUTCMinutes(), curDay, 0, 1);
  if (!((diff >= 0 && diff <= 6) || forceGvg)) return;

  const slotDate = dateUtc.toISOString().split('T')[0];
  const lockKey = `sent_gvg_daily_tasks_day_${curDay}_${slotDate}_00:01`;
  const what = `GvG Daily Tasks Day ${curDay}`;
  if (!(await claimSlot(run, lockKey, what, forceGvg))) return;

  try {
    const { roleId } = blockRoleTag(config, 'discord_role_id_gvg');
    const body = {
      ...buildGvgDailyTaskEmbed(curDay, formatDiscordRoleMention(roleId)),
      allowed_mentions: { parse: ['roles', 'users', 'everyone'] },
    };
    const sent = await postToDiscord(run, webhookUrlGvg, body, what);
    const taskDay = GVG_DAILY_TASKS[curDay];
    await settleSlot(
      run,
      lockKey,
      sent,
      { event: `GvG Daily Tasks - Day ${curDay} (${taskDay?.dayName})`, type: 'gvg_daily_tasks' },
      'GvG Daily Tasks webhook'
    );
  } catch (e) {
    await abandonSlot(run, lockKey, 'GvG Daily Tasks', e);
  }
}

interface GvgSlot {
  day: number;
  hour: number;
  minute: number;
  targetHour: number;
  targetMinute: number;
  label: string;
  type: 'now' | 'reminder';
}

const GVG_SCHEDULE: GvgSlot[] = [
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
  { day: 6, hour: 21, minute: 55, targetHour: 22, targetMinute: 0, label: 'War Fortress', type: 'reminder' },
];

function buildSaturdayMessage(run: GuildRun, slot: GvgSlot, gvgGuildTag: string) {
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

  const timeStr = `${pad2(slot.targetHour)}:${pad2(slot.targetMinute)} UTC`;

  const gvgAction = slot.type === 'now' ? 'start' : 'reminder';
  const { config } = run;
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

  const fields = [{ name: 'Start Time (UTC)', value: timeStr, inline: true }];
  if (agenda) {
    fields.push({ name: 'Guild Agenda', value: agenda, inline: false });
  }
  return reminderBody(content, embedTitle, embedDesc, color, fields);
}

export async function runGvgSaturday(run: GuildRun, allowed: boolean): Promise<void> {
  if (!allowed) return;
  const { config, now } = run;
  const webhookUrl = resolveGuildWebhook(config, 'gvg');
  if (!isToggleEnabled(config, 'notify_gvg_pvp') || webhookUrl === '') return;

  const { tag: gvgGuildTag } = blockRoleTag(config, 'discord_role_id_gvg');

  for (const slot of dueSlots(now, GVG_SCHEDULE)) {
    const slotDate = getSlotDateString(now, slot.day);
    const lockKey = `sent_gvg_${slot.label.replace(/\s+/g, '_')}_${slot.type}_${slotDate}_${pad2(slot.hour)}:${pad2(slot.minute)}`;
    if (!(await claimSlot(run, lockKey, `GvG ${slot.label} (${slot.type})`))) continue;

    try {
      const body = buildSaturdayMessage(run, slot, gvgGuildTag);
      const sent = await postToDiscord(run, webhookUrl, body, `GvG Saturday ${slot.label}`);
      await settleSlot(
        run,
        lockKey,
        sent,
        { event: `GvG Saturday - ${slot.label} (${slot.type})`, type: 'gvg_saturday' },
        'GvG Saturday reminder'
      );
    } catch (e) {
      await abandonSlot(run, lockKey, 'GvG Saturday', e);
    }
  }
}
