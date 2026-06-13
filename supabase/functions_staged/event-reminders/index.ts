/**
 * event-reminders v2, MULTI-TENANT (saas_strategy.md §5.3 / §10).
 *
 * STAGED: deploy only together with migrations_staged/ (see
 *    docs/cutover-runbook.md). Differences vs the live v1:
 *      - iterates every guild with a live subscription
 *      - reminder slots come from guild_event_schedules (per guild, UTC)
 *        instead of hardcoded GvG/SvS/Calamity tables
 *      - Discord webhook is per guild (guild_config), push subscriptions are
 *        filtered per guild
 *      - idempotency locks live in notification_locks (per guild), not in
 *        guild_config
 *
 * Triggered every minute by the pg_cron job (x-cron-secret header).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendNotification } from "npm:web-push-neo";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BRAND = "Guild Management Tool";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function getMinutesDiff(curDay: number, curHour: number, curMin: number, targetDay: number, targetHour: number, targetMin: number): number {
  const cur = curDay * 1440 + curHour * 60 + curMin;
  const target = targetDay * 1440 + targetHour * 60 + targetMin;
  let diff = cur - target;
  diff = (diff + 10080 + 5040) % 10080 - 5040; // normalize to [-5040, 5040]
  return diff;
}

function getSlotDateString(now: number, slotDay: number): string {
  const d = new Date(now);
  let dayDiff = slotDay - d.getUTCDay();
  if (dayDiff > 3) dayDiff -= 7;
  else if (dayDiff < -3) dayDiff += 7;
  d.setUTCDate(d.getUTCDate() + dayDiff);
  return d.toISOString().split("T")[0];
}

function getWeekStart(date: Date | string | number): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

async function sendDiscordWebhookWithRetry(url: string, body: unknown): Promise<boolean> {
  let attempts = 0;
  let delay = 500;
  while (attempts < 3) {
    attempts++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, isNaN(ra) ? 1000 : (ra < 120 ? ra * 1000 : ra)));
        continue;
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      console.error(`Discord webhook non-retriable status ${res.status}`);
      return false;
    } catch (err) {
      console.error(`Discord webhook network error: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return false;
}

// deno-lint-ignore no-explicit-any
async function sendWebPush(supabase: any, guildId: string, title: string, body: string) {
  try {
    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("guild_id", guildId);
    if (error) throw error;
    if (!subs?.length) return;

    const vapidDetails = {
      subject: "mailto:web-push@guildmanagement.internal",
      publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
      privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
    };
    if (!vapidDetails.publicKey || !vapidDetails.privateKey) return;

    const payload = JSON.stringify({ title, body: body.replace(/@everyone/g, "").trim(), url: "/app/" });
    for (const sub of subs) {
      try {
        await sendNotification({
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          vapidDetails,
        });
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 410 || e.statusCode === 404 || e.message?.includes("410") || e.message?.includes("404")) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
      }
    }
  } catch (e) {
    console.error("sendWebPush:", e);
  }
}

// ─── Idempotency locks (per guild) ───────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function acquireLock(supabase: any, guildId: string, lockKey: string): Promise<boolean> {
  const { error } = await supabase
    .from("notification_locks")
    .insert({ guild_id: guildId, lock_key: lockKey, status: "sending" });
  return !error; // unique violation means someone else holds it
}

// deno-lint-ignore no-explicit-any
async function settleLock(supabase: any, guildId: string, lockKey: string, ok: boolean) {
  if (ok) {
    await supabase.from("notification_locks")
      .update({ status: "sent" })
      .eq("guild_id", guildId).eq("lock_key", lockKey);
  } else {
    await supabase.from("notification_locks")
      .delete()
      .eq("guild_id", guildId).eq("lock_key", lockKey);
  }
}

// ─── Message templates per schedule kind ─────────────────────────────────────

interface Msg { content: string; title: string; desc: string; color: number; agenda: string }

function slotMessage(kind: string, label: string, offset: number, timeStr: string): Msg {
  const inMin = (n: number) => `starts in **${n} minutes**`;
  if (kind === "gvg_war_prism" || kind === "gvg_war_fortress") {
    const emoji = kind === "gvg_war_prism" ? "⚔️" : "🏰";
    const name = `GvG: ${label}`;
    if (offset === 0) {
      return {
        content: `${emoji} **${name}** starts now! @everyone`,
        title: `${emoji} GvG - ${label}`,
        desc: `The ${label} event is active. Join the battle now!`,
        color: kind === "gvg_war_prism" ? 9807270 : 15548997,
        agenda: `Secure the ${label} now.`,
      };
    }
    return {
      content: `⏰ **${name}** ${inMin(offset)}! @everyone`,
      title: `⏰ GvG - ${label} (Reminder)`,
      desc: `Get ready! The ${label} event starts in ${offset} minutes.`,
      color: 16750848,
      agenda: `Log in and prepare for the ${label}.`,
    };
  }
  if (kind === "svs_garrison") {
    return {
      content: `🛡️ **SvS: Garrison Reminder** - Don't forget to put your ships in garrison to avoid being attacked while offline! @everyone`,
      title: `🛡️ SvS: Garrison Reminder`,
      desc: `Protect your ships before going offline.`,
      color: 3447003,
      agenda: `Put your ships in garrison.`,
    };
  }
  if (kind === "svs_battle") {
    if (offset === 0) {
      return {
        content: `⚔️ **SvS: Battle has started!** Time to fight! @everyone`,
        title: `⚔️ SvS: Battle has started!`,
        desc: `The SvS battle begins now! To the attack!`,
        color: 15548997,
        agenda: `To the attack! Good luck to everyone.`,
      };
    }
    return {
      content: `${offset <= 5 ? "🚨" : "⏰"} **SvS: Battle ${inMin(offset)}!** @everyone`,
      title: `${offset <= 5 ? "🚨" : "⏰"} SvS: Starts in ${offset} minutes`,
      desc: offset <= 5 ? `Battle imminent! Join your squads!` : `The SvS battle will begin shortly. Prepare yourself!`,
      color: offset <= 5 ? 15548997 : 16750848,
      agenda: offset <= 5 ? `Join squads and be ready for combat.` : `Connection recommended soon for preparation.`,
    };
  }
  if (kind === "calamity_round") {
    // Calamity slots are always pre-battle reminders (seeds use offset 5).
    // Use the actual offset so a future offset=0 reads "now", not "5 minutes".
    if (offset === 0) {
      return {
        content: `⚔️ **Calamity Befalls: ${label}** starts now! @everyone`,
        title: `⚔️ Calamity Befalls - ${label}`,
        desc: `Calamity Befalls ${label} starts now. Join the battle!`,
        color: 15548997,
        agenda: `Log in and join the battle.`,
      };
    }
    return {
      content: `⏰ **Calamity Befalls: ${label} ${inMin(offset)}!** @everyone`,
      title: `⏰ Calamity Befalls - ${label} (Reminder)`,
      desc: `Prepare your squads! Calamity Befalls ${label} starts in ${offset} minutes.`,
      color: 16750848,
      agenda: `Log in and prepare for the battle.`,
    };
  }
  // custom
  if (offset === 0) {
    return {
      content: `⚔️ **${label}** starts now! @everyone`,
      title: `⚔️ ${label}`,
      desc: `${label} is starting now.`,
      color: 15548997,
      agenda: `Join now.`,
    };
  }
  return {
    content: `⏰ **${label}** ${inMin(offset)}! @everyone`,
    title: `⏰ ${label} (Reminder)`,
    desc: `${label} starts in ${offset} minutes.`,
    color: 16750848,
    agenda: `Log in and get ready.`,
  };
}

function embedBody(msg: Msg, timeStr: string) {
  return {
    content: msg.content,
    embeds: [{
      title: msg.title,
      description: msg.desc,
      color: msg.color,
      fields: [
        { name: "Start Time (UTC)", value: timeStr, inline: true },
        { name: "Guild Agenda", value: msg.agenda, inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: BRAND },
    }],
  };
}

// ─── Standard (start_at-driven) event messages — unchanged from v1 ──────────

function standardEventMessage(eventName: string, reminderType: string, dateFormatted: string) {
  let content = "";
  let title = `📢 Guild Event: ${eventName}`;
  let desc = `A guild event has been configured in the ${BRAND}!`;
  let color = 5763719;
  let agenda = "Please connect now.";

  if (reminderType === "reminder_30") {
    content = `⏰ **Reminder:** ${eventName} starts in **30 minutes**! @everyone`;
    title = `⏰ Reminder: ${eventName} starts in 30 minutes!`;
    desc = "Get ready, soldiers! Please log in and prepare for the event.";
    color = 16750848;
    agenda = "Please connect and get ready soon.";
  } else if (reminderType === "reminder_15") {
    content = `⏰ **Reminder:** ${eventName} starts in **15 minutes**! @everyone`;
    title = `⏰ Reminder: ${eventName} starts in 15 minutes!`;
    desc = "Get ready, soldiers! Please log in and prepare for the event.";
    color = 16750848;
    agenda = "Please connect and get ready.";
  } else if (reminderType === "reminder_5") {
    content = `🚨 **Immediate Reminder:** ${eventName} starts in **5 minutes**! Get ready! @everyone`;
    title = `🚨 Immediate Reminder: ${eventName} starts in 5 minutes!`;
    desc = "Action time! Join your squad now!";
    color = 15548997;
    agenda = "Action time! Connect now!";
  } else if (reminderType === "start") {
    content = `⚔️ **Event Started:** ${eventName} starts now! @everyone`;
    title = `⚔️ Event Started: ${eventName} is active!`;
    desc = "Action time! Join your squad now!";
    color = 15548997;
    agenda = "Battle starts now! Join your squad!";
  }
  return {
    content,
    embeds: [{
      title, description: desc, color,
      fields: [
        { name: "Start Time (UTC)", value: dateFormatted, inline: true },
        { name: "Guild Agenda", value: agenda, inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: BRAND },
    }],
    _title: title,
    _content: content,
  };
}

const STANDARD_EVENTS = new Set([
  "ARMS RACE STAGE A", "ARMS RACE STAGE B", "Defend Trade Route",
  "Shadowfront Squad 1", "Shadowfront Squad 2",
]);

// ─── Main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const xCronSecret = req.headers.get("x-cron-secret");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && xCronSecret !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const results: unknown[] = [];
  const now = Date.now();
  const dateUtc = new Date(now);
  const curDay = dateUtc.getUTCDay();
  const curHour = dateUtc.getUTCHours();
  const curMin = dateUtc.getUTCMinutes();

  try {
    // Tenants with reminders enabled = live subscription.
    const { data: guilds, error: gErr } = await supabase
      .from("guilds")
      .select("id, name, subscription_status")
      .in("subscription_status", ["trialing", "active", "past_due"]);
    if (gErr) throw gErr;

    for (const guild of guilds ?? []) {
      // Per-guild context
      const [{ data: configRows }, { data: events }, { data: schedules }] = await Promise.all([
        supabase.from("guild_config").select("key, value").eq("guild_id", guild.id),
        supabase.from("event_status").select("event_name, session_id, start_at, is_active").eq("guild_id", guild.id).eq("is_active", true),
        supabase.from("guild_event_schedules").select("*").eq("guild_id", guild.id).eq("enabled", true),
      ]);
      const config = Object.fromEntries((configRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
      const webhookUrl: string = config["discord_webhook_url"] ?? "";

      const activeThisWeek = new Set(
        (events ?? [])
          .filter((e) => getWeekStart(e.start_at || e.session_id) === getWeekStart(now))
          .map((e) => e.event_name),
      );

      // 1) Standard events driven by event_status.start_at
      for (const event of events ?? []) {
        if (!event.start_at || !STANDARD_EVENTS.has(event.event_name)) continue;
        const diffMins = Math.round((new Date(event.start_at).getTime() - now) / 60000);

        let reminderType = "";
        if (diffMins <= 30 && diffMins >= 26) reminderType = "reminder_30";
        else if (diffMins <= 15 && diffMins >= 11) reminderType = "reminder_15";
        else if (diffMins <= 5 && diffMins >= 1) reminderType = "reminder_5";
        else if (diffMins <= 0 && diffMins >= -4) reminderType = "start";
        if (!reminderType) continue;

        const lockKey = `evt_${event.event_name.replace(/\s+/g, "_")}_${event.session_id}_${reminderType}`;
        if (!(await acquireLock(supabase, guild.id, lockKey))) continue;

        const dateFormatted = new Date(event.start_at).toLocaleString("en-US", {
          weekday: "short", month: "2-digit", day: "2-digit", timeZone: "UTC",
          hour: "2-digit", minute: "2-digit", hour12: false,
        }) + " UTC";
        const body = standardEventMessage(event.event_name, reminderType, dateFormatted);

        const ok = webhookUrl.trim() ? await sendDiscordWebhookWithRetry(webhookUrl, body) : true;
        if (ok) await sendWebPush(supabase, guild.id, body._title, body._content);
        await settleLock(supabase, guild.id, lockKey, ok);
        if (ok) results.push({ guild: guild.name, event: event.event_name, type: reminderType });
      }

      // 2) Per-guild scheduled slots (GvG/SvS/Calamity/custom)
      for (const slot of schedules ?? []) {
        if (slot.requires_event && !activeThisWeek.has(slot.requires_event)) continue;

        const [hStr, mStr] = String(slot.time_utc).split(":");
        const slotHour = parseInt(hStr, 10);
        const slotMin = parseInt(mStr, 10);

        for (const offset of slot.reminder_offsets ?? []) {
          // Fire time = slot time minus `offset` minutes (weekly wraparound).
          const fireTotal = ((slot.day_utc * 1440 + slotHour * 60 + slotMin - offset) % 10080 + 10080) % 10080;
          const fireDay = Math.floor(fireTotal / 1440);
          const fireHour = Math.floor((fireTotal % 1440) / 60);
          const fireMin = fireTotal % 60;

          const diff = getMinutesDiff(curDay, curHour, curMin, fireDay, fireHour, fireMin);
          if (diff < 0 || diff > 10) continue;

          const slotDate = getSlotDateString(now, slot.day_utc);
          const hhmm = `${String(slotHour).padStart(2, "0")}:${String(slotMin).padStart(2, "0")}`;
          const lockKey = `sched_${slot.kind}_${(slot.label ?? "").replace(/\s+/g, "_")}_${slotDate}_${hhmm}_o${offset}`;
          if (!(await acquireLock(supabase, guild.id, lockKey))) continue;

          const msg = slotMessage(slot.kind, slot.label ?? slot.kind, offset, `${hhmm} UTC`);
          const body = embedBody(msg, `${hhmm} UTC`);

          const ok = webhookUrl.trim() ? await sendDiscordWebhookWithRetry(webhookUrl, body) : true;
          if (ok) await sendWebPush(supabase, guild.id, msg.title, msg.content);
          await settleLock(supabase, guild.id, lockKey, ok);
          if (ok) results.push({ guild: guild.name, slot: `${slot.kind}/${slot.label}`, offset });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
