// Characterization of the reminder cron (medium-term plan, M3). Each scenario
// runs the handler at a fixed instant against the in-memory Supabase and a
// stubbed Discord, and records what it did: every message sent and every
// database call, in order. The snapshots were taken from the single-file
// handler before it was split; the split must reproduce them exactly.
//
// Regenerate only for an intended behaviour change:
//   deno test --allow-all supabase/functions/event-reminders/scenarios.test.ts -- --update

import { assertSnapshot } from 'jsr:@std/testing@1/snapshot';
import { FakeSupabase, testEnv, uninstallFake } from '../_test/fake-supabase.ts';

testEnv({ CRON_SECRET: 'cron-test-secret' });
const { handler } = await import('./index.ts');

const HOOK = (n: number) => `https://discord.com/api/webhooks/${n}/tok_${n}`;

type Row = Record<string, unknown>;

interface Scenario {
  at: string;
  query?: string;
  events?: Row[];
  config?: Row[];
  warSessions?: Row[];
  /** Discord answers this status to every send. */
  discordStatus?: number;
}

/** A guild with a webhook for everything and the role ids set. */
function baseConfig(guild: string): Row[] {
  const rows: Record<string, string> = {
    discord_webhook_url: HOOK(1),
    webhook_armsrace: HOOK(2),
    webhook_gvg: HOOK(3),
    webhook_svs: HOOK(4),
    webhook_calamity: HOOK(5),
    discord_role_id: '111111111111111111',
    discord_role_id_gvg: '222222222222222222',
    discord_role_id_shadowfront_squad1: '333333333333333333',
  };
  // Every toggle on: a missing toggle is OFF (reminder-rules RC1).
  for (const p of ['armsrace', 'dtr', 'shadowfront']) {
    for (const t of ['reminder_30', 'reminder_5', 'start']) rows[`notify_${p}_${t}`] = 'true';
  }
  for (const k of ['gvg_daily_tasks', 'gvg_pvp', 'svs_garrison', 'svs_pvp', 'calamity_10'])
    rows[`notify_${k}`] = 'true';
  return Object.entries(rows).map(([key, value]) => ({ guild, key, value }));
}

async function run(t: Deno.TestContext, s: Scenario) {
  const fake = new FakeSupabase();
  fake.install();
  fake.table('guilds').push({ id: 'TA' }, { id: 'TB' });
  fake.table('event_status').push(...(s.events ?? []).map((e) => ({ is_active: true, ...e })));
  fake.table('guild_config').push(...baseConfig('TA'), ...(s.config ?? []));
  fake.table('war_sessions').push(...(s.warSessions ?? []));

  const sent: Array<{ url: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const fixed = new Date(s.at).getTime();
  Date.now = () => fixed;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? 'null'));
    for (const e of body?.embeds ?? []) delete e.timestamp;
    sent.push({ url: String(url), body });
    return Promise.resolve(new Response(null, { status: s.discordStatus ?? 204 }));
  }) as typeof fetch;

  try {
    const res = await handler(
      new Request(`https://edge.test/event-reminders${s.query ?? ''}`, {
        method: 'POST',
        headers: { 'x-cron-secret': 'cron-test-secret' },
        body: '{}',
      })
    );
    const db = fake.calls
      // Error logs land in system_audit_logs with a correlation id and a
      // duration: logging, not delivery, and never twice the same.
      .filter((c) => c.kind === 'from' && c.name !== 'system_audit_logs')
      .map((c) => {
        const args = c.args && typeof c.args === 'object' ? { ...(c.args as Row) } : c.args;
        if (args && typeof args === 'object') delete (args as Row).updated_at;
        const filters = (c.filters ?? []).filter(([col, op]) => !(col === 'updated_at' && op === 'gte'));
        return { table: c.name, op: c.op, args, filters };
      });
    await assertSnapshot(t, { status: res.status, response: await res.json(), sent, db });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    uninstallFake();
  }
}

Deno.test('standard events: 30 min, 5 min, start, a disabled toggle, a template, a stale event', async (t) => {
  await run(t, {
    at: '2026-10-05T12:00:00Z',
    events: [
      { guild: 'TA', event_name: 'Arms Race Stage A', session_id: 's1', start_at: '2026-10-05T12:28:00Z' },
      { guild: 'TA', event_name: 'Defend Trade Route', session_id: 's2', start_at: '2026-10-05T12:03:00Z' },
      { guild: 'TA', event_name: 'Shadowfront Squad 1', session_id: 's3', start_at: '2026-10-05T11:58:00Z' },
      { guild: 'TA', event_name: 'Arms Race Stage A', session_id: 'old', start_at: '2026-10-03T08:00:00Z' },
      { guild: 'TB', event_name: 'Arms Race Stage A', session_id: 's4', start_at: '2026-10-05T12:30:00Z' },
    ],
    config: [
      { guild: 'TA', key: 'notify_dtr_reminder_5', value: 'false' },
      { guild: 'TA', key: 'tpl_armsrace_reminder_30_content', value: 'Go {guild_tag}: {event_name} at {date}' },
      { guild: 'TA', key: 'tpl_armsrace_reminder_30_desc', value: 'Custom description' },
    ],
  });
});

Deno.test('locks: a sent slot is skipped, a fresh one too, a stale one is retried', async (t) => {
  await run(t, {
    at: '2026-10-05T12:00:00Z',
    events: [
      { guild: 'TA', event_name: 'Arms Race Stage A', session_id: 'a', start_at: '2026-10-05T12:28:00Z' },
      { guild: 'TA', event_name: 'Arms Race Stage A', session_id: 'b', start_at: '2026-10-05T12:28:00Z' },
      { guild: 'TA', event_name: 'Arms Race Stage A', session_id: 'c', start_at: '2026-10-05T12:28:00Z' },
    ],
    config: [
      {
        guild: 'TA',
        key: 'sent_event_Arms_Race_Stage_A_a_reminder_30',
        value: 'sent',
        updated_at: '2026-10-05T11:59:00Z',
      },
      {
        guild: 'TA',
        key: 'sent_event_Arms_Race_Stage_A_b_reminder_30',
        value: 'sending',
        updated_at: '2026-10-05T11:58:00Z',
      },
      {
        guild: 'TA',
        key: 'sent_event_Arms_Race_Stage_A_c_reminder_30',
        value: 'sending',
        updated_at: '2026-10-05T11:40:00Z',
      },
    ],
  });
});

Deno.test('a Discord refusal releases the lock', async (t) => {
  await run(t, {
    at: '2026-10-05T12:00:00Z',
    events: [{ guild: 'TA', event_name: 'Arms Race Stage A', session_id: 's1', start_at: '2026-10-05T12:28:00Z' }],
    discordStatus: 400,
  });
});

Deno.test('GvG daily tasks at Monday 00:03', async (t) => {
  await run(t, { at: '2026-10-05T00:03:00Z' });
});

Deno.test('GvG daily tasks forced outside their slot', async (t) => {
  await run(t, { at: '2026-10-07T15:00:00Z', query: '?force=gvg&guild=ta' });
});

Deno.test('Saturday 00:02: GvG daily, War Prism and the SvS portal of an active week', async (t) => {
  await run(t, {
    at: '2026-10-10T00:02:00Z',
    warSessions: [{ guild: 'TA', event_name: 'SvS', start_at: '2026-10-05T10:00:00Z' }],
  });
});

Deno.test('Friday 23:56: GvG and SvS 5-minute reminders, with a GvG template', async (t) => {
  await run(t, {
    at: '2026-10-09T23:56:00Z',
    events: [{ guild: 'TA', event_name: 'SvS', session_id: 'w', start_at: null }],
    config: [{ guild: 'TA', key: 'tpl_gvg_reminder_title', value: '{event_name} at {date} {guild_tag}' }],
  });
});

Deno.test('SvS garrison on Friday 20:01, and nothing when the week has no SvS', async (t) => {
  await run(t, {
    at: '2026-10-09T20:01:00Z',
    events: [{ guild: 'TA', event_name: 'SvS', session_id: 'w', start_at: '2026-10-06T09:00:00Z' }],
  });
  await run(t, { at: '2026-10-09T20:01:00Z' });
});

Deno.test('SvS battle reminders, invasion with a template and defense', async (t) => {
  const svs = [{ guild: 'TA', event_name: 'SvS', session_id: 'w', start_at: '2026-10-06T09:00:00Z' }];
  await run(t, {
    at: '2026-10-10T13:31:00Z',
    events: svs,
    config: [
      { guild: 'TA', key: 'notify_svs_won_prep', value: 'true' },
      { guild: 'TA', key: 'tpl_svs_reminder_30_invasion_desc', value: '{event_name} {date} {guild_tag}' },
    ],
  });
  await run(t, { at: '2026-10-10T14:01:00Z', events: svs });
  await run(t, {
    at: '2026-10-10T13:56:00Z',
    events: svs,
    config: [{ guild: 'TA', key: 'notify_svs_pvp', value: 'false' }],
  });
});

Deno.test('Calamity rounds, and the toggle that stops them', async (t) => {
  await run(t, {
    at: '2026-10-06T02:51:00Z',
    config: [{ guild: 'TA', key: 'tpl_calamity_reminder_10_content', value: 'Round {round} {date} {guild_tag}' }],
  });
  await run(t, { at: '2026-10-05T23:55:00Z' });
  await run(t, {
    at: '2026-10-05T23:55:00Z',
    config: [{ guild: 'TA', key: 'notify_calamity_10', value: 'false' }],
  });
});
