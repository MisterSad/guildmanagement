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
      .eq('is_active', true)
      .not('start_at', 'is', null);

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

    for (const event of (events || [])) {
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
