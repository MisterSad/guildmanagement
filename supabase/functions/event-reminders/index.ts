import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sendNotification } from "npm:web-push-neo"

async function sendWebPush(supabase: any, title: string, body: string) {
  try {
    const { data: subs, error: subError } = await supabase
      .from('push_subscriptions')
      .select('*');

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
        console.log(`Web Push sent successfully to sub ID: ${sub.id}`);
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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

serve(async (req) => {
  const authHeader = req.headers.get('Authorization');
  const xCronSecret = req.headers.get('x-cron-secret');
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && xCronSecret !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // 1. Fetch active scheduled events
    const { data: events, error: eventError } = await supabase
      .from('event_status')
      .select('event_name, session_id, start_at')
      .eq('is_active', true);

    if (eventError) throw eventError;

    // 2. Fetch discord webhook configuration
    const { data: configRows, error: configError } = await supabase
      .from('guild_config')
      .select('key, value');
      
    if (configError) throw configError;

    const config = Object.fromEntries(configRows.map(r => [r.key, r.value]));
    const webhookUrl = config['discord_webhook_url'];

    const now = Date.now();
    const results = [];

    // Check standard events with a start_at time
    for (const event of (events || [])) {
      if (!event.start_at) continue;

      const startMs = new Date(event.start_at).getTime();
      const diffMs = startMs - now;
      const diffMins = diffMs / 60000;
      const roundedMins = Math.round(diffMins);

      let trigger = false;
      let reminderType = '';

      const isShadowfrontSquad = event.event_name === 'Shadowfront Squad 1' || event.event_name === 'Shadowfront Squad 2';

      if (isShadowfrontSquad) {
        if (roundedMins === 30 || roundedMins === 15 || roundedMins === 5 || roundedMins === 0) {
          trigger = true;
          reminderType = roundedMins === 30 ? 'reminder_30'
            : roundedMins === 15 ? 'reminder_15'
            : roundedMins === 5  ? 'reminder_5'
            : 'start';
        }
      } else {
        if (roundedMins === 15 || roundedMins === 5) {
          trigger = true;
          reminderType = roundedMins === 15 ? 'reminder_15' : 'reminder_5';
        }
      }

      if (trigger) {
        const dateFormatted = new Date(event.start_at).toLocaleDateString('fr-FR', {
          weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC',
          hour: '2-digit', minute: '2-digit'
        }) + ' UTC';

        let content = '';
        let embedTitle = `📢 Guild Event: ${event.event_name}`;
        let embedDesc = 'A guild event has been configured in the RAD Management tool!';
        let color = 5763719; // Green
        let agenda = 'Please connect now.';

        if (reminderType === 'reminder_30') {
          content = `⏰ **Reminder:** ${event.event_name} starts in **30 minutes**! @everyone`;
          embedTitle = `⏰ Reminder: ${event.event_name} starts in 30 minutes!`;
          embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
          color = 16750848; // Orange
          agenda = 'Please connect and get ready soon.';
        } else if (reminderType === 'reminder_15') {
          content = `⏰ **Reminder:** ${event.event_name} starts in **15 minutes**! @everyone`;
          embedTitle = `⏰ Reminder: ${event.event_name} starts in 15 minutes!`;
          embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
          color = 16750848; // Orange
          agenda = 'Please connect and get ready.';
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

        if (webhookUrl && webhookUrl.trim() !== '') {
          try {
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
                footer: { text: 'RAD Management Tool' }
              }]
            };

            const discordRes = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            
            if (!discordRes.ok) {
              console.error(`Discord reminder webhook failed with status: ${discordRes.status}`);
            }
          } catch (e) {
            console.error('Error sending Discord webhook reminder:', e);
          }
        }

        await sendWebPush(supabase, embedTitle, content);
        results.push({ event: event.event_name, type: reminderType, status: 'sent' });
      }
    }

    // 3. GvG Saturday notifications and reminders
    const isGvgActive = (events || []).some(e => e.event_name === 'GvG');
    if (isGvgActive) {
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

      const matchingSlot = GVG_SCHEDULE.find(slot => {
        if (slot.day !== curDay || slot.hour !== curHour) return false;
        return Math.abs(slot.minute - curMin) <= 1;
      });

      if (matchingSlot) {
        try {
          let content = '';
          let embedTitle = '';
          let embedDesc = '';
          let color = 5763719;
          let agenda = '';

          if (matchingSlot.type === 'now') {
            if (matchingSlot.label === 'War Prism') {
              content = `⚔️ **GvG: War Prism** starts now! @everyone`;
              embedTitle = `⚔️ GvG - War Prism`;
              embedDesc = `The War Prism event is active. Join the battle now!`;
              color = 9807270;
              agenda = `Secure the War Prism now.`;
            } else if (matchingSlot.label === 'War Fortress') {
              content = `🏰 **GvG: War Fortress** starts now! @everyone`;
              embedTitle = `🏰 GvG - War Fortress`;
              embedDesc = `The War Fortress event is active. All units to their stations!`;
              color = 15548997;
              agenda = `Secure the War Fortress now.`;
            }
          } else {
            if (matchingSlot.label === 'War Prism') {
              content = `⏰ **GvG: War Prism** starts in **5 minutes**! @everyone`;
              embedTitle = `⏰ GvG - War Prism (Reminder)`;
              embedDesc = `Get ready! The War Prism event starts in 5 minutes.`;
              color = 16750848;
              agenda = `Log in and prepare for the War Prism.`;
            } else if (matchingSlot.label === 'War Fortress') {
              content = `⏰ **GvG: War Fortress** starts in **5 minutes**! @everyone`;
              embedTitle = `⏰ GvG - War Fortress (Reminder)`;
              embedDesc = `Get ready! The War Fortress event starts in 5 minutes.`;
              color = 16750848;
              agenda = `Log in and prepare for the War Fortress.`;
            }
          }

          const startHourStr = String(matchingSlot.targetHour).padStart(2, '0');
          const startMinStr = String(matchingSlot.targetMinute).padStart(2, '0');
          const timeStr = `${startHourStr}:${startMinStr} UTC`;

          if (webhookUrl && webhookUrl.trim() !== '') {
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
                footer: { text: 'RAD Management Tool' }
              }]
            };

            const discordRes = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });

            if (!discordRes.ok) {
              console.error(`Discord GvG Saturday reminder webhook failed with status: ${discordRes.status}`);
            }
          }

          await sendWebPush(supabase, embedTitle, content);
          results.push({ event: `GvG Saturday - ${matchingSlot.label} (${matchingSlot.type})`, type: 'gvg_saturday', status: 'sent' });
        } catch (e) {
          console.error('Error sending Discord GvG Saturday webhook:', e);
        }
      }
    }

    // 4. SvS notifications and reminders
    const isSvsActive = (events || []).some(e => e.event_name === 'SvS');
    if (isSvsActive) {
      const dateUtc = new Date(now);
      const curDay = dateUtc.getUTCDay();
      const curHour = dateUtc.getUTCHours();
      const curMin = dateUtc.getUTCMinutes();

      const SVS_SCHEDULE = [
        { day: 5, hour: 20, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
        { day: 5, hour: 21, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
        { day: 5, hour: 22, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
        { day: 5, hour: 23, minute: 0, label: 'Garrison Reminder', type: 'garrison' },

        { day: 6, hour: 13, minute: 30, label: 'Battle Reminder 30m', type: 'reminder_30' },
        { day: 6, hour: 13, minute: 45, label: 'Battle Reminder 15m', type: 'reminder_15' },
        { day: 6, hour: 13, minute: 55, label: 'Battle Reminder 5m', type: 'reminder_5' },
        { day: 6, hour: 14, minute: 0, label: 'Battle Start', type: 'battle_start' }
      ];

      const matchingSlot = SVS_SCHEDULE.find(slot => {
        if (slot.day !== curDay || slot.hour !== curHour) return false;
        return Math.abs(slot.minute - curMin) <= 1;
      });

      if (matchingSlot) {
        try {
          let content = '';
          let embedTitle = '';
          let embedDesc = '';
          let color = 5763719;
          let agenda = '';
          let fields: any[] = [];

          if (matchingSlot.type === 'garrison') {
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
            const timeStr = '14:00 UTC';
            
            if (matchingSlot.type === 'reminder_30') {
              content = `⏰ **SvS: Battle starts in 30 minutes!** @everyone`;
              embedTitle = `⏰ SvS: Starts in 30 minutes`;
              embedDesc = `The SvS battle will begin shortly. Prepare yourself!`;
              color = 16750848;
              agenda = `Connection recommended soon for preparation.`;
            } else if (matchingSlot.type === 'reminder_15') {
              content = `⏰ **SvS: Battle starts in 15 minutes!** @everyone`;
              embedTitle = `⏰ SvS: Starts in 15 minutes`;
              embedDesc = `Soldiers, prepare your lines. Connection highly recommended.`;
              color = 16750848;
              agenda = `Prepare your fleets and log in.`;
            } else if (matchingSlot.type === 'reminder_5') {
              content = `🚨 **SvS: Battle starts in 5 minutes!** @everyone`;
              embedTitle = `🚨 SvS: Starts in 5 minutes!`;
              embedDesc = `Battle imminent! Join your squads!`;
              color = 15548997;
              agenda = `Join squads and be ready for combat.`;
            } else if (matchingSlot.type === 'battle_start') {
              content = `⚔️ **SvS: Battle has started!** Time to fight! @everyone`;
              embedTitle = `⚔️ SvS: Battle has started!`;
              embedDesc = `The SvS battle begins now! To the attack!`;
              color = 15548997;
              agenda = `To the attack! Good luck to everyone.`;
            }

            fields = [
              { name: 'Start Time (UTC)', value: timeStr, inline: true },
              { name: 'Guild Agenda', value: agenda, inline: false }
            ];
          }

          if (webhookUrl && webhookUrl.trim() !== '') {
            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'RAD Management Tool' }
              }]
            };

            const discordRes = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });

            if (!discordRes.ok) {
              console.error(`Discord SvS reminder webhook failed with status: ${discordRes.status}`);
            }
          }

          await sendWebPush(supabase, embedTitle, content);
          results.push({ event: `SvS - ${matchingSlot.label}`, type: `svs_${matchingSlot.type}`, status: 'sent' });
        } catch (e) {
          console.error('Error sending Discord SvS webhook:', e);
        }
      }
    }

    // 5. Calamity Befalls weekly reminders
    {
      const dateUtc = new Date(now);
      const curDay = dateUtc.getUTCDay();
      const curHour = dateUtc.getUTCHours();
      const curMin = dateUtc.getUTCMinutes();

      const CALAMITY_SCHEDULE = [
        { day: 1, hour: 23, minute: 55, round: 1, targetHour: 0, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 2, minute: 55, round: 2, targetHour: 3, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 5, minute: 55, round: 3, targetHour: 6, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 8, minute: 55, round: 4, targetHour: 9, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 11, minute: 55, round: 5, targetHour: 12, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 14, minute: 55, round: 6, targetHour: 15, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 17, minute: 55, round: 7, targetHour: 18, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 20, minute: 55, round: 8, targetHour: 21, targetMinute: 0, targetDay: 'Tuesday' },
        { day: 2, hour: 23, minute: 55, round: 9, targetHour: 0, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 2, minute: 55, round: 10, targetHour: 3, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 5, minute: 55, round: 11, targetHour: 6, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 8, minute: 55, round: 12, targetHour: 9, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 11, minute: 55, round: 13, targetHour: 12, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 14, minute: 55, round: 14, targetHour: 15, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 17, minute: 55, round: 15, targetHour: 18, targetMinute: 0, targetDay: 'Wednesday' },
        { day: 3, hour: 20, minute: 55, round: 16, targetHour: 21, targetMinute: 0, targetDay: 'Wednesday' }
      ];

      const matchingSlot = CALAMITY_SCHEDULE.find(slot => {
        if (slot.day !== curDay || slot.hour !== curHour) return false;
        return Math.abs(slot.minute - curMin) <= 1;
      });

      if (matchingSlot) {
        try {
          const content = `⏰ **Calamity Befalls: Round ${matchingSlot.round} starts in 5 minutes!** @everyone`;
          const embedTitle = `⏰ Calamity Befalls - Round ${matchingSlot.round} (Reminder)`;
          const embedDesc = `Prepare your squads! Calamity Befalls Round ${matchingSlot.round} starts in 5 minutes.`;
          const color = 16750848;
          const agenda = 'Log in and prepare for the battle.';

          const startHourStr = String(matchingSlot.targetHour).padStart(2, '0');
          const startMinStr = String(matchingSlot.targetMinute).padStart(2, '0');
          const timeStr = `${matchingSlot.targetDay} · ${startHourStr}:${startMinStr} UTC`;

          if (webhookUrl && webhookUrl.trim() !== '') {
            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: [
                  { name: 'Round', value: `${matchingSlot.round} / 16`, inline: true },
                  { name: 'Start Time (UTC)', value: timeStr, inline: true },
                  { name: 'Guild Agenda', value: agenda, inline: false }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'RAD Management Tool' }
              }]
            };

            const discordRes = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });

            if (!discordRes.ok) {
              console.error(`Discord Calamity Befalls reminder webhook failed with status: ${discordRes.status}`);
            }
          }

          await sendWebPush(supabase, embedTitle, content);
          results.push({ event: `Calamity Befalls - Round ${matchingSlot.round}`, type: 'calamity_befalls', status: 'sent' });
        } catch (e) {
          console.error('Error sending Discord Calamity Befalls webhook:', e);
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: results }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
})
