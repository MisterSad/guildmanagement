import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sendNotification } from "npm:web-push-neo"

async function sendWebPush(supabase: any, title: string, body: string, guild: string) {
  try {
    const { data: subs, error: subError } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('guild', guild);

    if (subError) throw subError;
    if (!subs || subs.length === 0) return;

    const vapidDetails = {
      subject: 'mailto:web-push@guildmanagement.internal',
      publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
      privateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
    };

    if (!vapidDetails.publicKey || !vapidDetails.privateKey) {
      console.warn('VAPID keys not configured in Supabase secrets, skipping Web Push');
      return;
    }

    const payload = {
      title,
      body: body.replace(/@everyone/g, '').trim(),
      url: '/'
    };

    for (const sub of subs) {
      try {
        const subscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        await sendNotification({
          subscription,
          payload: JSON.stringify(payload),
          vapidDetails
        });
        console.log(`Web Push sent successfully to sub ID: ${sub.id} (Guild: ${guild})`);
      } catch (err: any) {
        console.error(`Failed to send Web Push to sub ID ${sub.id}:`, err);
        if (err.statusCode === 410 || err.statusCode === 404 || err.message?.includes('410') || err.message?.includes('404')) {
          console.log(`Cleaning up expired subscription ID: ${sub.id}`);
          await supabase
            .from('push_subscriptions')
            .delete()
            .eq('id', sub.id);
        }
      }
    }
  } catch (e) {
    console.error('Error in sendWebPush:', e);
  }
}

async function sendDiscordWebhookWithRetry(url: string, body: any): Promise<boolean> {
  let attempts = 0;
  const maxAttempts = 3;
  let delay = 500; // 500ms initial backoff

  while (attempts < maxAttempts) {
    attempts++;
    try {
      console.log(`Sending Discord webhook attempt ${attempts} to: ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
        console.warn(`Discord Rate Limit (429) hit. Waiting ${waitMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (res.status >= 500) {
        console.warn(`Discord server error (${res.status}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff
        continue;
      }

      console.error(`Discord webhook failed with non-retriable status: ${res.status}`);
      return false;

    } catch (err: any) {
      console.error(`Network error sending Discord webhook: ${err.message}. Retrying in ${delay}ms...`);
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

serve(async (req) => {
  const authHeader = req.headers.get('Authorization');
  const xCronSecret = req.headers.get('x-cron-secret');
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && xCronSecret !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // 0. Fetch all active guilds dynamically
    const { data: guildRows, error: guildError } = await supabase
      .from('guilds')
      .select('id');
    if (guildError) throw guildError;
    const GUILDS = (guildRows || []).map((r: any) => r.id);

    // 1. Fetch all active scheduled events across all guilds
    const { data: allEvents, error: eventError } = await supabase
      .from('event_status')
      .select('guild, event_name, session_id, start_at')
      .eq('is_active', true);

    if (eventError) throw eventError;

    // 2. Fetch all config rows across all guilds
    const { data: configRows, error: configError } = await supabase
      .from('guild_config')
      .select('guild, key, value');
      
    if (configError) throw configError;

    // Group configuration by guild
    const configsByGuild: Record<string, Record<string, string>> = {};
    for (const g of GUILDS) {
      configsByGuild[g] = {};
    }
    for (const row of (configRows || [])) {
      const g = row.guild || 'ALPHA';
      if (configsByGuild[g]) {
        configsByGuild[g][row.key] = row.value;
      }
    }

    const now = Date.now();
    const results: any[] = [];

    // Loop through each guild tenant
    for (const guild of GUILDS) {
      const config = configsByGuild[guild];
      const events = (allEvents || []).filter(e => (e.guild || 'ALPHA') === guild);

      // Check standard events with a start_at time
      for (const event of events) {
        if (!event.start_at) continue;

        const isStandardEvent = event.event_name === 'ARMS RACE STAGE A' ||
                                event.event_name === 'ARMS RACE STAGE B' ||
                                event.event_name === 'Defend Trade Route' ||
                                event.event_name === 'Shadowfront Squad 1' ||
                                event.event_name === 'Shadowfront Squad 2';
        if (!isStandardEvent) continue;

        const startMs = new Date(event.start_at).getTime();
        const diffMs = startMs - now;
        const diffMins = diffMs / 60000;
        const roundedMins = Math.round(diffMins);

        let trigger = false;
        let reminderType = '';

        if (roundedMins <= 30 && roundedMins >= 26) {
          trigger = true;
          reminderType = 'reminder_30';
        } else if (roundedMins <= 5 && roundedMins >= 1) {
          trigger = true;
          reminderType = 'reminder_5';
        } else if (roundedMins <= 0 && roundedMins >= -4) {
          trigger = true;
          reminderType = 'start';
        }

        if (trigger) {
          // Check configuration toggle
          let eventPrefix = '';
          if (event.event_name.startsWith('ARMS RACE')) {
            eventPrefix = 'armsrace';
          } else if (event.event_name === 'Defend Trade Route') {
            eventPrefix = 'dtr';
          } else if (event.event_name.startsWith('Shadowfront Squad')) {
            eventPrefix = 'shadowfront';
          }

          if (eventPrefix) {
            const configKey = `notify_${eventPrefix}_${reminderType}`;
            const isNotificationEnabled = config[configKey] === undefined || config[configKey] === 'true';
            if (!isNotificationEnabled) {
              console.log(`[${guild}] Notification for ${event.event_name} (${reminderType}) is disabled in configuration, skipping.`);
              continue;
            }

            const webhookUrl = config[`webhook_${eventPrefix}`];
            const lockKey = `sent_event_${event.event_name.replace(/\s+/g, '_')}_${event.session_id}_${reminderType}`;

            // Fast-path memory check
            if (config[lockKey] === 'sent' || config[lockKey] === 'sending') {
              continue;
            }

            // Acquire lock
            const { error: lockErr } = await supabase
              .from('guild_config')
              .insert({ guild: guild, key: lockKey, value: 'sending', updated_at: new Date().toISOString() });

            if (lockErr) {
              console.log(`[${guild}] Lock already exists for standard event ${event.event_name} (${reminderType}), skipping`);
              continue;
            }

            let sentSuccess = false;
            const dateFormatted = new Date(event.start_at).toLocaleString('en-US', {
              weekday: 'short', month: '2-digit', day: '2-digit', timeZone: 'UTC',
              hour: '2-digit', minute: '2-digit', hour12: false
            }) + ' UTC';

            let content = '';
            const embedTitle = `📢 Guild Event: ${event.event_name}`;
            let embedDesc = 'A guild event has been configured in the FGF Guild Management tool!';
            let color = 5763719; // Green
            let agenda = 'Please connect now.';

            if (reminderType === 'reminder_30') {
              content = `⏰ **Reminder:** ${event.event_name} starts in **30 minutes**! @everyone`;
              embedTitle = `⏰ Reminder: ${event.event_name} starts in 30 minutes!`;
              embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
              color = 16750848; // Orange
              agenda = 'Please connect and get ready soon.';
            } else if (reminderType === 'reminder_5') {
              content = `🚨 **Immediate Reminder:** ${event.event_name} starts in **5 minutes**! Get ready! @everyone`;
              embedTitle = `🚨 Immediate Reminder: ${event.event_name} starts in 5 minutes!`;
              embedDesc = 'Action time! Join your squad now!';
              color = 15548997; // Bright Red
              agenda = 'Action time! Connect now!';
            } else if (reminderType === 'start') {
              content = `⚔️ **Event Started:** ${event.event_name} starts now! @everyone`;
              embedTitle = `⚔️ Event Started: ${event.event_name} is active!`;
              embedDesc = 'Action time! Join your squad now!';
              color = 15548997; // Bright Red
              agenda = 'Battle starts now! Join your squad!';
            }

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: [
                  { name: 'Start Time (UTC)', value: dateFormatted, inline: true },
                  { name: 'Guild Agenda', value: agenda, inline: false }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'FGF Guild Management Tool' }
              }]
            };

            if (webhookUrl && webhookUrl.trim() !== '') {
              sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
            } else {
              sentSuccess = true; // No webhook configured
            }

            if (sentSuccess) {
              await sendWebPush(supabase, embedTitle, content, guild);
              try {
                await supabase
                  .from('guild_config')
                  .update({ value: 'sent', updated_at: new Date().toISOString() })
                  .eq('guild', guild)
                  .eq('key', lockKey);
              } catch (dbErr) {
                console.error(`[${guild}] Error updating standard event lock ${lockKey}:`, dbErr);
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
                console.error(`[${guild}] Error releasing standard event lock ${lockKey}:`, dbErr);
              }
              console.error(`[${guild}] Failed to send standard event ${event.event_name} reminder. Lock released.`);
            }
          }
        }
      }

      // 3. GvG Saturday notifications and reminders
      const gvgEvent = events.find(e => e.event_name === 'GvG');
      const isGvgActive = gvgEvent && getWeekStart(gvgEvent.start_at || gvgEvent.session_id) === getWeekStart(now);
      if (isGvgActive) {
        const isGvgPvpEnabled = config['notify_gvg_pvp'] === undefined || config['notify_gvg_pvp'] === 'true';
        if (isGvgPvpEnabled) {
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

            // Fast-path memory check
            if (config[lockKey] === 'sent' || config[lockKey] === 'sending') {
              continue;
            }

            // Acquire lock
            const { error: lockErr } = await supabase
              .from('guild_config')
              .insert({ guild: guild, key: lockKey, value: 'sending', updated_at: new Date().toISOString() });

            if (lockErr) {
              console.log(`[${guild}] Lock already exists for GvG ${slot.label} (${slot.type}), skipping`);
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

              const body = {
                content: content,
                embeds: [{
                  title: embedTitle,
                  description: embedDesc,
                  color: color,
                  fields: [
                    { name: 'Start Time (UTC)', value: timeStr, inline: true },
                    { name: 'Guild Agenda', value: agenda, inline: false }
                  ],
                  timestamp: new Date().toISOString(),
                  footer: { text: 'FGF Guild Management Tool' }
                }]
              };

              const webhookUrl = config['webhook_gvg'];
              let sentSuccess = false;
              if (webhookUrl && webhookUrl.trim() !== '') {
                sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
              } else {
                sentSuccess = true;
              }

              if (sentSuccess) {
                await sendWebPush(supabase, embedTitle, content, guild);
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
                console.error(`[${guild}] Failed to send GvG Saturday reminder. Lock released.`);
              }
            } catch (e) {
              console.error(`[${guild}] Error sending Discord GvG Saturday webhook:`, e);
              await supabase
                .from('guild_config')
                .delete()
                .eq('guild', guild)
                .eq('key', lockKey);
            }
          }
        }
      }

      // 4. SvS notifications and reminders
      const svsEvent = events.find(e => e.event_name === 'SvS');
      const isSvsActive = svsEvent && getWeekStart(svsEvent.start_at || svsEvent.session_id) === getWeekStart(now);
      if (isSvsActive) {
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
          const wonPrep = config['notify_svs_won_prep'] === 'true';
          if (slot.type === 'portal_5' || slot.type === 'portal_open') {
            const isSvsPvpEnabled = config['notify_svs_pvp'] === undefined || config['notify_svs_pvp'] === 'true';
            if (!isSvsPvpEnabled || !wonPrep) {
              console.log(`[${guild}] SvS Portal notification (${slot.type}) skipped (PvP disabled or prep phase not won).`);
              continue;
            }
          } else if (slot.type === 'garrison') {
            const isGarrisonEnabled = config['notify_svs_garrison'] === undefined || config['notify_svs_garrison'] === 'true';
            if (!isGarrisonEnabled) {
              console.log(`[${guild}] SvS Garrison Reminder is disabled in configuration, skipping.`);
              continue;
            }
          } else {
            const isSvsPvpEnabled = config['notify_svs_pvp'] === undefined || config['notify_svs_pvp'] === 'true';
            if (!isSvsPvpEnabled) {
              console.log(`[${guild}] SvS PvP Day notification (${slot.type}) is disabled in configuration, skipping.`);
              continue;
            }
          }

          const slotDate = getSlotDateString(now, slot.day);
          const lockKey = `sent_svs_${slot.label.replace(/\s+/g, '_')}_${slot.type}_${slotDate}_${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;

          // Fast-path memory check
          if (config[lockKey] === 'sent' || config[lockKey] === 'sending') {
            continue;
          }

          // Acquire lock
          const { error: lockErr } = await supabase
            .from('guild_config')
            .insert({ guild: guild, key: lockKey, value: 'sending', updated_at: new Date().toISOString() });

          if (lockErr) {
            console.log(`[${guild}] Lock already exists for SvS ${slot.label} (${slot.type}), skipping`);
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
              content = `🛡️ **SvS: Garrison Reminder** - Don't forget to put your ships in garrison to avoid being attacked while offline! @everyone`;
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
              const wonPrep = config['notify_svs_won_prep'] === 'true';
              
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

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'FGF Guild Management Tool' }
              }]
            };

            const webhookUrl = config['webhook_svs'];
            let sentSuccess = false;
            if (webhookUrl && webhookUrl.trim() !== '') {
              sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
            } else {
              sentSuccess = true;
            }

            if (sentSuccess) {
              await sendWebPush(supabase, embedTitle, content, guild);
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
              console.error(`[${guild}] Failed to send SvS reminder. Lock released.`);
            }
          } catch (e) {
            console.error(`[${guild}] Error sending Discord SvS webhook:`, e);
            await supabase
              .from('guild_config')
              .delete()
              .eq('guild', guild)
              .eq('key', lockKey);
          }
        }
      }

      // 5. Calamity Befalls weekly reminders (10m before round)
      {
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
          const isCalamityEnabled = config['notify_calamity_10'] === undefined || config['notify_calamity_10'] === 'true';
          if (!isCalamityEnabled) {
            console.log(`[${guild}] Calamity Befalls Round reminders are disabled in configuration, skipping.`);
            continue;
          }

          const slotDate = getSlotDateString(now, slot.day);
          const lockKey = `sent_calamity_round_${slot.round}_${slotDate}`;

          // Fast-path memory check
          if (config[lockKey] === 'sent' || config[lockKey] === 'sending') {
            continue;
          }

          // Acquire lock
          const { error: lockErr } = await supabase
            .from('guild_config')
            .insert({ guild: guild, key: lockKey, value: 'sending', updated_at: new Date().toISOString() });

          if (lockErr) {
            console.log(`[${guild}] Lock already exists for Calamity Round ${slot.round}, skipping`);
            continue;
          }

          try {
            const content = `⏰ **Calamity Befalls: Round ${slot.round} starts in 10 minutes!** @everyone`;
            const embedTitle = `⏰ Calamity Befalls - Round ${slot.round} (Reminder)`;
            const embedDesc = `Prepare your squads! Calamity Befalls Round ${slot.round} starts in 10 minutes.`;
            const color = 16750848;
            const agenda = 'Log in and prepare for the battle.';

            const startHourStr = String(slot.targetHour).padStart(2, '0');
            const startMinStr = String(slot.targetMinute).padStart(2, '0');
            const timeStr = `${slot.targetDay} · ${startHourStr}:${startMinStr} UTC`;

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: [
                  { name: 'Round', value: `${slot.round} / 16`, inline: true },
                  { name: 'Start Time (UTC)', value: timeStr, inline: true },
                  { name: 'Guild Agenda', value: agenda, inline: false }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'FGF Guild Management Tool' }
              }]
            };

            const webhookUrl = config['webhook_calamity'];
            let sentSuccess = false;
            if (webhookUrl && webhookUrl.trim() !== '') {
              sentSuccess = await sendDiscordWebhookWithRetry(webhookUrl, body);
            } else {
              sentSuccess = true;
            }

            if (sentSuccess) {
              await sendWebPush(supabase, embedTitle, content, guild);
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
              console.error(`[${guild}] Failed to send Calamity Befalls reminder. Lock released.`);
            }
          } catch (e) {
            console.error(`[${guild}] Error sending Discord Calamity Befalls webhook:`, e);
            await supabase
              .from('guild_config')
              .delete()
              .eq('guild', guild)
              .eq('key', lockKey);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: results }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
})
