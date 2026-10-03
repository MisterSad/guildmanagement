/**
 * supabase/functions/event-reminders/index.ts
 *
 * The reminder cron, run every few minutes by pg_cron (gm_invoke_event_reminders).
 * This file authenticates the caller, loads every guild's events and reminder
 * config in four queries, and runs each reminder block per guild:
 *
 *   standard.ts  Arms Race / Trade Route / Shadowfront: 30 min, 5 min, start
 *   gvg.ts       GvG daily task list, Saturday War Prism / War Fortress
 *   svs.ts       SvS garrison, portal and battle, in an SvS week only
 *   calamity.ts  Calamity Befalls, 10 minutes before each of 16 rounds
 *
 * shared.ts holds the slot lock, the Discord sender and the weekly clock.
 * scenarios.test.ts pins what the cron sends and writes, tick by tick.
 */

import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";
import { STATIC_CONFIG_KEYS, type GuildRun } from "./shared.ts";
import { runStandardEvents, type ActiveEvent } from "./standard.ts";
import { runGvgDailyTasks, runGvgSaturday } from "./gvg.ts";
import { runSvs } from "./svs.ts";
import { runCalamity } from "./calamity.ts";

let logger = new EdgeLogger("event-reminders");

// PWA Web Push decommissioned per user request: all notifications are now routed to Discord exclusively.

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

export async function handler(req: Request): Promise<Response> {
  const json = makeJson(req);
  logger = new EdgeLogger("event-reminders", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });

  const authHeader = req.headers.get('Authorization') || '';
  const xCronSecret = req.headers.get('x-cron-secret') || '';
  const cronSecret = Deno.env.get('CRON_SECRET');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || SUPABASE_SERVICE_ROLE_KEY;
  const supabase = serviceClient();
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
    const results: unknown[] = [];

    for (const guild of GUILDS) {
      const run: GuildRun = {
        supabase, logger, guild, now, forceGvg, results,
        config: configsByGuild[guild],
        lockTimes: lockTimes[guild],
      };
      const events = (allEvents || []).filter((e: any) => e.guild === guild) as ActiveEvent[];

      // The order is the order Discord receives them in.
      await runStandardEvents(run, events);
      await runGvgDailyTasks(run);
      await runGvgSaturday(run);
      await runSvs(run, events, svsWarByGuild[guild] || []);
      await runCalamity(run);
    }

    return json({ ok: true, processed: results }, 200);

  } catch (err: any) {
    logger.error('Event reminders execution error', err);
    return json({ error: err.message }, 500);
  }
}

serveUnlessTest(handler);
