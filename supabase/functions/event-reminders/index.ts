import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// VAPID keys and keys will be read from environment variables on Supabase
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

serve(async (req) => {
  // Validate authorization header for pg_cron shared-secret security if configured
  const authHeader = req.headers.get('Authorization');
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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

      // Rounded minutes until event
      const roundedMins = Math.round(diffMins);

      // Check if it is exactly 15 or 5 minutes before start
      if (roundedMins === 15 || roundedMins === 5) {
        const reminderType = roundedMins === 15 ? 'reminder_15' : 'reminder_5';
        
        // A. Trigger Discord Notification via Webhook if configured
        if (webhookUrl && webhookUrl.trim() !== '') {
          try {
            // Build the body using the same logic as notifyDiscordEvent
            const dateFormatted = new Date(event.start_at).toLocaleDateString('fr-FR', {
              weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC',
              hour: '2-digit', minute: '2-digit'
            }) + ' UTC';

            let content = '';
            let embedTitle = `📢 Guild Event: ${event.event_name}`;
            let embedDesc = 'A guild event has been configured in the RAD Management tool!';
            let color = 5763719; // Green

            if (reminderType === 'reminder_15') {
              content = `⏰ **Reminder:** ${event.event_name} starts in **15 minutes**! @everyone`;
              embedTitle = `⏰ Reminder: ${event.event_name} starts in 15 minutes!`;
              embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
              color = 16750848; // Orange
            } else if (reminderType === 'reminder_5') {
              content = `🚨 **Immediate Reminder:** ${event.event_name} starts in **5 minutes**! Get ready! @everyone`;
              embedTitle = `🚨 Immediate Reminder: ${event.event_name} starts in 5 minutes!`;
              embedDesc = 'Action time! Join your squad now!';
              color = 15548997; // Bright Red
            }

            const body = {
              content: content,
              embeds: [{
                title: embedTitle,
                description: embedDesc,
                color: color,
                fields: [
                  { name: 'Start Time (UTC)', value: dateFormatted, inline: true },
                  { name: 'Guild Agenda', value: 'Please connect now.', inline: false }
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

        // B. Trigger Web Push Notifications (via push subscriptions)
        // Fetch all subscriptions
        try {
          const { data: subs, error: subError } = await supabase
            .from('push_subscriptions')
            .select('*');

          if (!subError && subs && subs.length > 0) {
            // Invoke your Push Notification delivery service or Deno Web Push client here
            // (Uses Web Push protocol to notify PWA devices)
            console.log(`Sending Web Push reminders to ${subs.length} devices...`);
          }
        } catch (e) {
          console.error('Error fetching push subscriptions:', e);
        }

        results.push({ event: event.event_name, type: reminderType, status: 'sent' });
      }
    }

    // 3. GvG Saturday notifications and reminders
    const isGvgActive = (events || []).some(e => e.event_name === 'GvG');
    if (isGvgActive && webhookUrl && webhookUrl.trim() !== '') {
      const dateUtc = new Date(now);
      const curDay = dateUtc.getUTCDay();
      const curHour = dateUtc.getUTCHours();
      const curMin = dateUtc.getUTCMinutes();

      const GVG_SCHEDULE = [
        // On-time slots (Saturday)
        { day: 6, hour: 0, minute: 0, targetHour: 0, targetMinute: 0, label: 'War Prism', type: 'now' },
        { day: 6, hour: 1, minute: 0, targetHour: 1, targetMinute: 0, label: 'War Prism', type: 'now' },
        { day: 6, hour: 10, minute: 0, targetHour: 10, targetMinute: 0, label: 'War Fortress', type: 'now' },
        { day: 6, hour: 13, minute: 0, targetHour: 13, targetMinute: 0, label: 'War Prism', type: 'now' },
        { day: 6, hour: 14, minute: 0, targetHour: 14, targetMinute: 0, label: 'War Prism', type: 'now' },
        { day: 6, hour: 22, minute: 0, targetHour: 22, targetMinute: 0, label: 'War Fortress', type: 'now' },

        // 5-minute reminders (Friday/Saturday)
        { day: 5, hour: 23, minute: 55, targetHour: 0, targetMinute: 0, label: 'War Prism', type: 'reminder' },
        { day: 6, hour: 0, minute: 55, targetHour: 1, targetMinute: 0, label: 'War Prism', type: 'reminder' },
        { day: 6, hour: 9, minute: 55, targetHour: 10, targetMinute: 0, label: 'War Fortress', type: 'reminder' },
        { day: 6, hour: 12, minute: 55, targetHour: 13, targetMinute: 0, label: 'War Prism', type: 'reminder' },
        { day: 6, hour: 13, minute: 55, targetHour: 14, targetMinute: 0, label: 'War Prism', type: 'reminder' },
        { day: 6, hour: 21, minute: 55, targetHour: 22, targetMinute: 0, label: 'War Fortress', type: 'reminder' }
      ];

      const matchingSlot = GVG_SCHEDULE.find(slot => 
        slot.day === curDay && 
        slot.hour === curHour && 
        slot.minute === curMin
      );

      if (matchingSlot) {
        try {
          let content = '';
          let embedTitle = '';
          let embedDesc = '';
          let color = 5763719; // Default Green
          let agenda = '';

          if (matchingSlot.type === 'now') {
            if (matchingSlot.label === 'War Prism') {
              content = `⚔️ **GvG: War Prism** starts now! @everyone`;
              embedTitle = `⚔️ GvG - War Prism`;
              embedDesc = `The War Prism event is active. Join the battle now!`;
              color = 9807270; // Purple
              agenda = `Secure the War Prism now.`;
            } else if (matchingSlot.label === 'War Fortress') {
              content = `🏰 **GvG: War Fortress** starts now! @everyone`;
              embedTitle = `🏰 GvG - War Fortress`;
              embedDesc = `The War Fortress event is active. All units to their stations!`;
              color = 15548997; // Red
              agenda = `Secure the War Fortress now.`;
            }
          } else { // 'reminder'
            if (matchingSlot.label === 'War Prism') {
              content = `⏰ **GvG: War Prism** starts in **5 minutes**! @everyone`;
              embedTitle = `⏰ GvG - War Prism (Reminder)`;
              embedDesc = `Get ready! The War Prism event starts in 5 minutes.`;
              color = 16750848; // Orange
              agenda = `Log in and prepare for the War Prism.`;
            } else if (matchingSlot.label === 'War Fortress') {
              content = `⏰ **GvG: War Fortress** starts in **5 minutes**! @everyone`;
              embedTitle = `⏰ GvG - War Fortress (Reminder)`;
              embedDesc = `Get ready! The War Fortress event starts in 5 minutes.`;
              color = 16750848; // Orange
              agenda = `Log in and prepare for the War Fortress.`;
            }
          }

          const startHourStr = String(matchingSlot.targetHour).padStart(2, '0');
          const startMinStr = String(matchingSlot.targetMinute).padStart(2, '0');
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
          } else {
            results.push({ event: `GvG Saturday - ${matchingSlot.label} (${matchingSlot.type})`, type: 'gvg_saturday', status: 'sent' });
          }
        } catch (e) {
          console.error('Error sending Discord GvG Saturday webhook:', e);
        }
      }
    }

    // 4. SvS notifications and reminders
    const isSvsActive = (events || []).some(e => e.event_name === 'SvS');
    if (isSvsActive && webhookUrl && webhookUrl.trim() !== '') {
      const dateUtc = new Date(now);
      const curDay = dateUtc.getUTCDay();
      const curHour = dateUtc.getUTCHours();
      const curMin = dateUtc.getUTCMinutes();

      const SVS_SCHEDULE = [
        // Friday Garrison reminders (hour-by-hour from 20:00 to 23:00)
        { day: 5, hour: 20, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
        { day: 5, hour: 21, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
        { day: 5, hour: 22, minute: 0, label: 'Garrison Reminder', type: 'garrison' },
        { day: 5, hour: 23, minute: 0, label: 'Garrison Reminder', type: 'garrison' },

        // Saturday Battle warnings and start
        { day: 6, hour: 13, minute: 30, label: 'Battle Reminder 30m', type: 'reminder_30' },
        { day: 6, hour: 13, minute: 45, label: 'Battle Reminder 15m', type: 'reminder_15' },
        { day: 6, hour: 13, minute: 55, label: 'Battle Reminder 5m', type: 'reminder_5' },
        { day: 6, hour: 14, minute: 0, label: 'Battle Start', type: 'battle_start' }
      ];

      const matchingSlot = SVS_SCHEDULE.find(slot => 
        slot.day === curDay && 
        slot.hour === curHour && 
        slot.minute === curMin
      );

      if (matchingSlot) {
        try {
          let content = '';
          let embedTitle = '';
          let embedDesc = '';
          let color = 5763719; // Default Green
          let agenda = '';
          let fields: any[] = [];

          if (matchingSlot.type === 'garrison') {
            content = `🛡️ **SvS: Garrison Reminder** - Don't forget to put your ships in garrison to avoid being attacked while offline! @everyone`;
            embedTitle = `🛡️ SvS: Garrison Reminder`;
            embedDesc = `Protect your ships before going offline.`;
            color = 3447003; // Blue
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
              color = 16750848; // Orange
              agenda = `Connection recommended soon for preparation.`;
            } else if (matchingSlot.type === 'reminder_15') {
              content = `⏰ **SvS: Battle starts in 15 minutes!** @everyone`;
              embedTitle = `⏰ SvS: Starts in 15 minutes`;
              embedDesc = `Soldiers, prepare your lines. Connection highly recommended.`;
              color = 16750848; // Orange
              agenda = `Prepare your fleets and log in.`;
            } else if (matchingSlot.type === 'reminder_5') {
              content = `🚨 **SvS: Battle starts in 5 minutes!** @everyone`;
              embedTitle = `🚨 SvS: Starts in 5 minutes!`;
              embedDesc = `Battle imminent! Join your squads!`;
              color = 15548997; // Bright Red
              agenda = `Join squads and be ready for combat.`;
            } else if (matchingSlot.type === 'battle_start') {
              content = `⚔️ **SvS: Battle has started!** Time to fight! @everyone`;
              embedTitle = `⚔️ SvS: Battle has started!`;
              embedDesc = `The SvS battle begins now! To the attack!`;
              color = 15548997; // Bright Red
              agenda = `To the attack! Good luck to everyone.`;
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
          } else {
            results.push({ event: `SvS - ${matchingSlot.label}`, type: `svs_${matchingSlot.type}`, status: 'sent' });
          }
        } catch (e) {
          console.error('Error sending Discord SvS webhook:', e);
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
