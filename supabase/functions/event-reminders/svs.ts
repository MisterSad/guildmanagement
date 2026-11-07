/**
 * SvS: Friday garrison reminders, the Saturday invasion portal, and the
 * Saturday 14:00 battle (worded for invasion or defense by
 * notify_svs_won_prep). Only in a week that has an SvS (RC6).
 */

import { isToggleEnabled, resolveGuildWebhook, isSvsEventName, isSvsActiveForWeek } from '../_shared/reminder-rules.ts';
import {
  claimSlot,
  settleSlot,
  abandonSlot,
  postToDiscord,
  reminderBody,
  blockRoleTag,
  getSlotDateString,
  dueSlots,
  pad2,
  type GuildRun,
} from './shared.ts';
import type { ActiveEvent } from './standard.ts';

type SvsSlotType = 'garrison' | 'portal_5' | 'portal_open' | 'reminder_30' | 'reminder_5' | 'battle_start';
interface SvsSlot {
  day: number;
  hour: number;
  minute: number;
  label: string;
  type: SvsSlotType;
}

const SVS_SCHEDULE: SvsSlot[] = [
  { day: 5, hour: 20, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
  { day: 5, hour: 21, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
  { day: 5, hour: 22, minute: 0, label: 'Garrison Reminder', type: 'garrison' },

  { day: 5, hour: 23, minute: 55, label: 'Portal Reminder 5m', type: 'portal_5' },
  { day: 6, hour: 0, minute: 0, label: 'Portal Open', type: 'portal_open' },

  { day: 6, hour: 13, minute: 30, label: 'Battle Reminder 30m', type: 'reminder_30' },
  { day: 6, hour: 13, minute: 55, label: 'Battle Reminder 5m', type: 'reminder_5' },
  { day: 6, hour: 14, minute: 0, label: 'Battle Start', type: 'battle_start' },
];

/** Whether the guild's toggles let this slot post; logs why not. */
function slotEnabled(run: GuildRun, slot: SvsSlot): boolean {
  const { config, logger, guild } = run;
  if (slot.type === 'portal_5' || slot.type === 'portal_open') {
    // RC7: portal battle notifications are detached from won_prep — only
    // notify_svs_pvp gates them. notify_svs_won_prep remains a pure
    // content switch (invasion vs defense wording) further below.
    if (!isToggleEnabled(config, 'notify_svs_pvp')) {
      logger.info(`[${guild}] SvS Portal notification (${slot.type}) skipped (PvP disabled).`);
      return false;
    }
  } else if (slot.type === 'garrison') {
    if (!isToggleEnabled(config, 'notify_svs_garrison')) {
      logger.info(`[${guild}] SvS Garrison Reminder is disabled in configuration, skipping.`);
      return false;
    }
  } else if (!isToggleEnabled(config, 'notify_svs_pvp')) {
    logger.info(`[${guild}] SvS PvP Day notification (${slot.type}) is disabled in configuration, skipping.`);
    return false;
  }
  return true;
}

function buildMessage(run: GuildRun, slot: SvsSlot, svsGuildTag: string) {
  const { config, now } = run;
  const curHour = new Date(now).getUTCHours();
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
      { name: 'Time (UTC)', value: `${pad2(curHour)}:00 UTC`, inline: true },
      { name: 'Guild Agenda', value: agenda, inline: false },
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
      { name: 'Guild Agenda', value: agenda, inline: false },
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

    const timeVal =
      slot.type === 'garrison'
        ? `${pad2(slot.hour)}:00 UTC`
        : slot.type === 'portal_5' || slot.type === 'portal_open'
          ? '00:00 UTC'
          : '14:00 UTC';

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
      fields = [{ name: 'Time (UTC)', value: timeVal, inline: true }];
    }
  }
  return reminderBody(content, embedTitle, embedDesc, color, fields);
}

/**
 * RC6: the guild runs an SvS in the current UTC calendar week: an active
 * event_status SvS row whose start_at falls in the week (or has no start_at),
 * or a durable war_sessions SvS row of the week. The legacy 7.5-day sliding
 * window silently killed weekly SvS reminders mid-cycle and is gone.
 */
export function isSvsWeek(now: number, events: ActiveEvent[], warSessionTimestampsMs: Array<number | null>): boolean {
  const svsEvent = events.find((e) => isSvsEventName(e.event_name));
  return isSvsActiveForWeek(now, {
    eventActive: !!svsEvent,
    eventStartAtMs: svsEvent && svsEvent.start_at ? new Date(svsEvent.start_at).getTime() : null,
    warSessionTimestampsMs,
  });
}

export async function runSvs(run: GuildRun, svsWeek: boolean): Promise<void> {
  if (!svsWeek) return;
  const { config, now } = run;

  const { tag: svsGuildTag } = blockRoleTag(config, 'discord_role_id_svs');

  for (const slot of dueSlots(now, SVS_SCHEDULE)) {
    if (!slotEnabled(run, slot)) continue;

    const slotDate = getSlotDateString(now, slot.day);
    const lockKey = `sent_svs_${slot.label.replace(/\s+/g, '_')}_${slot.type}_${slotDate}_${pad2(slot.hour)}:${pad2(slot.minute)}`;
    if (!(await claimSlot(run, lockKey, `SvS ${slot.label} (${slot.type})`))) continue;

    try {
      const body = buildMessage(run, slot, svsGuildTag);
      const sent = await postToDiscord(run, resolveGuildWebhook(config, 'svs'), body, `SvS ${slot.label}`);
      await settleSlot(run, lockKey, sent, { event: `SvS - ${slot.label}`, type: `svs_${slot.type}` }, 'SvS reminder');
    } catch (e) {
      await abandonSlot(run, lockKey, 'SvS', e);
    }
  }
}
