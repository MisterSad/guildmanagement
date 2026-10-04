// Regression guard for two live production bugs found and fixed 2026-09-02:
//
// 1. Web Push: sendNotification (web-push-neo) takes 3 positional args
//    (subscription, payload, options), but the code called it with a single
//    {subscription, payload, vapidDetails} object -- so subscription.endpoint
//    was undefined and EVERY Web Push send failed, for every subscription
//    (confirmed live: 10/10 valid subscriptions all failing the same way).
//
// 2. Duplicate Discord notifications: the per-guild "lock" used to prevent
//    sending the same reminder twice used a merge .upsert(), which never
//    errors on a primary-key conflict (guild_config's real PK is
//    (guild, key)) -- it just silently overwrites. A slow invocation
//    overlapping with the next minute's cron tick meant both read a stale
//    "no lock yet" snapshot and both sent. Confirmed live: 6 consecutive cron
//    ticks (00:01-00:06 UTC) all timed out the same morning 6 duplicate GvG
//    Day 3 messages were reported. A plain .insert() then surfaced the
//    conflict as a Postgres unique violation on every overlap (log noise,
//    wasted round-trips). Acquisition now goes through acquireReminderLock,
//    which uses upsert({ ignoreDuplicates: true }) -- ON CONFLICT DO NOTHING:
//    it never overwrites, returns no row when the lock is already held, and
//    raises no constraint error.

import { describe, it, expect } from 'vitest';
import { squash } from './helpers/source-text.js';
import fs from 'fs';
import path from 'path';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const content = edgeSource('event-reminders');

describe('event-reminders: Web Push decommissioning', () => {
  it('confirms Web Push has been decommissioned in favor of Discord notifications', () => {
    expect(content).toContain('// PWA Web Push decommissioned per user request: all notifications are now routed to Discord exclusively.');
    expect(content).not.toContain('npm:web-push-neo');
  });
});

describe('event-reminders: reminder locks are atomic (ON CONFLICT DO NOTHING)', () => {
  it('acquires send-locks through acquireReminderLock with ignoreDuplicates, never a merge-upsert', () => {
    // A merge-upsert silently overwrote on conflict; a plain insert raised a
    // real PK violation on every overlap. ignoreDuplicates maps to
    // ON CONFLICT DO NOTHING, so it never overwrites and returns no row when
    // the lock is already held.
    expect(content).toContain("ignoreDuplicates: true");
    expect(content).toContain("onConflict: 'guild,key'");
    expect(content).not.toContain('.insert({ guild: guild, key: lockKey');
    expect(content).not.toMatch(/\.upsert\(\s*\{[^}]*guild[^}]*key: lockKey[^}]*\}\s*\)/);
  });

  it('every lock-acquisition site goes through acquireReminderLock', () => {
    // M3: one claim path, claimSlot(), is the only caller of
    // acquireReminderLock, and every block claims through it.
    expect(content.match(/await acquireReminderLock\(/g) || []).toHaveLength(1);
    expect(edgeFunctionBody('event-reminders', 'claimSlot')).toContain('await acquireReminderLock(run, lockKey)');
    // Standard events, GvG daily tasks, GvG Saturday, SvS, Calamity -- 5 sites.
    expect(content.match(/await claimSlot\(run, lockKey/g) || []).toHaveLength(5);
  });

  it('the GvG daily task lock treats an already-held lock as "already sent" and skips, rather than silently doing nothing', () => {
    const claim = edgeFunctionBody('event-reminders', 'claimSlot');
    // The formatter writes `!(await …)`; both read the same.
    expect(squash(claim)).toMatch(/if \(!\(?await acquireReminderLock\(run, lockKey\)\)?\) \{ run\.logger\.info\(`\[\$\{run\.guild\}\] Lock already exists for \$\{what\}, skipping`\); return false;/);
    // The formatter writes `!(await …)`; both read the same.
    expect(edgeFunctionBody('event-reminders', 'runGvgDailyTasks')).toMatch(/if \(!\(?await claimSlot\(run, lockKey, what, forceGvg\)\)?\) return;/);
  });
});

describe('event-reminders: Discord webhook allowed_mentions and role handling', () => {
  it('includes allowed_mentions: { parse: [\'roles\', \'users\', \'everyone\'] } on all webhook payloads in event-reminders', () => {
    const everyone = /allowed_mentions:\s*\{\s*parse:\s*\[\s*['"]roles['"],\s*['"]users['"],\s*['"]everyone['"]\s*\]\s*\}/;
    // M3: four blocks build their payload with reminderBody(); the GvG daily
    // task list spreads its own embed and adds the same allowed_mentions.
    expect(edgeFunctionBody('event-reminders', 'reminderBody')).toMatch(everyone);
    expect(content.match(/return reminderBody\(/g) || []).toHaveLength(4);
    expect(edgeFunctionBody('event-reminders', 'runGvgDailyTasks')).toMatch(everyone);
  });

  it('supports dedicated role IDs for Shadowfront Squad 1 and Squad 2 with fallback', () => {
    expect(squash(content)).toContain(squash("normalizeEventName(event.event_name) === 'SHADOWFRONT SQUAD 1' && config['discord_role_id_shadowfront_squad1']?.trim()"));
    expect(squash(content)).toContain(squash("normalizeEventName(event.event_name) === 'SHADOWFRONT SQUAD 2' && config['discord_role_id_shadowfront_squad2']?.trim()"));
    expect(content).toContain("eventSpecificRoleId = config[`discord_role_id_${eventPrefix}`] || null;");
  });

  it('uses svsGuildTag for SvS garrison reminder instead of hardcoded @everyone', () => {
    expect(content).toContain('${svsGuildTag || \'@everyone\'}');
    expect(content).not.toMatch(/content:\s*`🏰\s*\*\*SvS Battle Day - Base Defense Alert!\*\*\s*@everyone`/);
  });

  it('auto-expires stale events older than 24 hours in event-reminders', () => {
    expect(content).toContain('const DAY_MS = 24 * 60 * 60 * 1000;');
    expect(content).toMatch(/\(?now - startMs\)? > DAY_MS/);
    expect(content).toContain("is_active: false");
  });
});

describe('discord-webhook-proxy: allowed_mentions defaults', () => {
  const proxyFilePath = path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts');
  const proxyContent = fs.readFileSync(proxyFilePath, 'utf-8');

  it('ensures payload.allowed_mentions defaults to parsing roles, users, and everyone', () => {
    expect(proxyContent).toContain('!payload.allowed_mentions');
    expect(proxyContent).toContain('payload.allowed_mentions = { parse: ["roles", "users", "everyone"] };');
  });
});

describe('event-reminders: strict toggle evaluation (P0 RC1/RC2 — no more ghost notifications)', () => {
  it('imports the shared reminder rules (isToggleEnabled + resolveGuildWebhook)', () => {
    expect(content).toMatch(/from ["']\.\.\/_shared\/reminder-rules\.ts["']/);
  });

  it('no longer uses the default-ON patterns (== undefined || == "true"), != "false" gates, or the gvg_svs_calamity_enabled master gate', () => {
    expect(content).not.toMatch(/=== undefined \|\| config\[[^\]]*\] === 'true'/);
    expect(content).not.toMatch(/!== 'false'/);
    expect(content).not.toContain("config['gvg_svs_calamity_enabled']");
  });

  it('has removed the locally redefined resolveGuildWebhook (falls back only when the category key was never set)', () => {
    expect(content).not.toContain('function resolveGuildWebhook(');
  });
});

describe('event-reminders: webhook category silencing (P0 RC3)', () => {
  it('relies on the shared resolveGuildWebhook for every category send site', () => {
    const matches = content.match(/resolveGuildWebhook\(config, /g) || [];
    // Standard events, GvG daily tasks, GvG Saturday, SvS, Calamity -- 5 sites.
    expect(matches.length).toBe(5);
  });
});

describe('frontend: allowed_mentions and squad 2 role support', () => {
  const gmUtilsPath = path.resolve(__dirname, '../src/core/integrations/discord.ts');
  const gmUtilsContent = fs.readFileSync(gmUtilsPath, 'utf-8');
  const shadowfrontViewContent = fs.readFileSync(path.resolve(__dirname, '../src/modules/shadowfront/views/ShadowfrontView.ts'), 'utf-8');
  const shadowfrontServiceContent = fs.readFileSync(path.resolve(__dirname, '../src/modules/shadowfront/shadowfront.service.ts'), 'utf-8');

  it('gm-utils sendDiscordWebhookDetailed guarantees allowed_mentions', () => {
    expect(gmUtilsContent).toContain("body.allowed_mentions = body.allowed_mentions || { parse: ['roles', 'users', 'everyone'] };");
  });

  it('gm-utils notifyDiscordEvent handles Squad 1 and Squad 2 role configs', () => {
    expect(gmUtilsContent).toContain("eventName === 'Shadowfront Squad 1'");
    expect(gmUtilsContent).toContain("getGuildConfig('discord_role_id_shadowfront_squad1')");
    expect(gmUtilsContent).toContain("eventName === 'Shadowfront Squad 2'");
    expect(gmUtilsContent).toContain("getGuildConfig('discord_role_id_shadowfront_squad2')");
  });

  it('the Shadowfront share uses squad 1 / squad 2 roles and allowed_mentions', () => {
    expect(shadowfrontViewContent).toContain("squadKey === 'squad2' ? 'discord_role_id_shadowfront_squad2' : 'discord_role_id_shadowfront_squad1'");
    expect(shadowfrontServiceContent).toContain("allowed_mentions: { parse: ['roles', 'users', 'everyone'] }");
  });
});
