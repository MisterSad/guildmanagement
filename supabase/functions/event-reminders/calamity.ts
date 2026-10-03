/**
 * Calamity Befalls: a reminder 10 minutes before each of the 16 weekly rounds
 * (Monday 23:50 to Wednesday 20:50 UTC).
 */

import { isToggleEnabled, resolveGuildWebhook } from "../_shared/reminder-rules.ts";
import { claimSlot, settleSlot, abandonSlot, postToDiscord, reminderBody, blockRoleTag, getSlotDateString, dueSlots, pad2, type GuildRun } from "./shared.ts";

interface CalamitySlot { day: number; hour: number; minute: number; round: number; targetHour: number; targetMinute: number; targetDay: string }

const CALAMITY_SCHEDULE: CalamitySlot[] = [
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

function buildMessage(run: GuildRun, slot: CalamitySlot, calamityGuildTag: string) {
  let content = `⏰ **Calamity Befalls: Round ${slot.round} starts in 10 minutes!**`;
  let embedTitle = `⏰ Calamity Befalls - Round ${slot.round} (Reminder)`;
  let embedDesc = `Prepare your squads! Calamity Befalls Round ${slot.round} starts in 10 minutes.`;
  const color = 16750848;
  let agenda = 'Log in and prepare for the battle.';

  const timeStr = `${slot.targetDay} · ${pad2(slot.targetHour)}:${pad2(slot.targetMinute)} UTC`;

  const { config } = run;
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
  return reminderBody(content, embedTitle, embedDesc, color, fields);
}

export async function runCalamity(run: GuildRun): Promise<void> {
  const { config, now, logger, guild } = run;
  const { tag: calamityGuildTag } = blockRoleTag(config, 'discord_role_id_calamity');

  for (const slot of dueSlots(now, CALAMITY_SCHEDULE)) {
    if (!isToggleEnabled(config, 'notify_calamity_10')) {
      logger.info(`[${guild}] Calamity Befalls Round reminders are disabled in configuration, skipping.`);
      continue;
    }

    const lockKey = `sent_calamity_round_${slot.round}_${getSlotDateString(now, slot.day)}`;
    if (!await claimSlot(run, lockKey, `Calamity Round ${slot.round}`)) continue;

    try {
      const body = buildMessage(run, slot, calamityGuildTag);
      const sent = await postToDiscord(run, resolveGuildWebhook(config, 'calamity'), body, `Calamity Round ${slot.round}`);
      await settleSlot(run, lockKey, sent, { event: `Calamity Befalls - Round ${slot.round}`, type: 'calamity_befalls' }, 'Calamity Befalls reminder');
    } catch (e) {
      await abandonSlot(run, lockKey, 'Calamity Befalls', e);
    }
  }
}
