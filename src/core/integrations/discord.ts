/**
 * src/core/integrations/discord.ts
 *
 * Discord webhook dispatch ported from gm-utils.js: role-mention formatting,
 * which webhooks are set (never their URLs), the Edge Function proxy -- the
 * only path to Discord, and the only writer of webhook URLs -- and event
 * notifications/reminders.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { SUPABASE_URL, SUPABASE_KEY } from '../config/constants';
import { formatPower, escapeHTML } from '../utils/text';
import { getGuildConfig } from '../config/guild-config';
import { getActiveGuild } from '../auth/roles';
import { getClient, ensureAuthSession } from '../api/supabase';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : {}) as any;
}

/** Formats a role id / mention into a Discord <@&id> mention. */
export function formatDiscordRoleMention(input?: string | null): string {
  if (!input || typeof input !== 'string') return '@everyone';
  const str = input.trim();
  if (!str || str === '@everyone') return '@everyone';
  if (str === '@here') return '@here';
  const match = str.match(/\d{15,22}/);
  if (match) return '<@&' + match[0] + '>';
  if (str.indexOf('<@&') === 0 && str.indexOf('>') === str.length - 1) return str;
  return str;
}

/**
 * The webhook keys whose fallback chain the proxy and the reminder cron walk:
 * the event's own, then the default, then any other event's.
 */
export const DISCORD_WEBHOOK_KEYS = [
  'discord_webhook_url',
  'webhook_armsrace', 'webhook_svs', 'webhook_gvg', 'webhook_dtr', 'webhook_calamity', 'webhook_shadowfront'
];

/**
 * Which webhook keys of the guild are set -- never their URLs (ARC-04). Null
 * when it cannot be told (no client, no guild, refused), so a caller can tell
 * "none" from "unknown".
 */
export async function configuredWebhooks(guild?: string | null): Promise<string[] | null> {
  const g = guild || getActiveGuild();
  const client = getClient();
  if (!g || !client) return null;
  try {
    const res = await client.rpc('gm_configured_webhooks', { p_guild: g });
    if (res.error || !Array.isArray(res.data)) return null;
    return res.data as string[];
  } catch (_) {
    return null;
  }
}

/** Whether the proxy would find a webhook for this event (same chain as the proxy). */
export function webhookChainIsSet(configured: string[] | null | undefined, eventPrefix?: string): boolean {
  if (!configured || configured.length === 0) return false;
  if (eventPrefix && configured.indexOf('webhook_' + eventPrefix) !== -1) return true;
  return DISCORD_WEBHOOK_KEYS.some((k) => configured.indexOf(k) !== -1);
}

/** Sets (or, with an empty URL, removes) one webhook through the proxy. */
export async function setDiscordWebhook(key: string, url: string, guild?: string | null): Promise<{ ok: boolean; error?: string }> {
  const g = guild || getActiveGuild();
  const client = getClient();
  if (!g || !client) return { ok: false, error: 'no_guild' };
  try { await ensureAuthSession(); } catch (_) { /* best-effort */ }
  try {
    const res = await client.functions.invoke('discord-webhook-proxy', {
      body: { action: 'set-webhook', guild: g, key, url: String(url || '').trim() }
    });
    if (res.data && res.data.ok) return { ok: true };
    const err = (res.data && res.data.error) || (res.error && (res.error.message || String(res.error))) || 'save_failed';
    return { ok: false, error: String(err) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Sends a webhook body via the Edge proxy, which resolves the guild's webhook
 * server-side. The browser never names a URL (ARC-04).
 */
export async function sendDiscordWebhookDetailed(eventPrefix: string, body: any): Promise<{ ok: boolean; error?: any }> {
  try { await ensureAuthSession(); } catch (_) { /* best-effort */ }
  const currentG = getActiveGuild();
  if (typeof eventPrefix === 'string' && eventPrefix.indexOf('http') === 0) {
    return { ok: false, error: 'client_webhook_url_not_allowed' };
  }
  const targetPrefix = eventPrefix;

  body.allowed_mentions = body.allowed_mentions || { parse: ['roles', 'users', 'everyone'] };

  const client = getClient();
  if (client && client.functions && typeof client.functions.invoke === 'function') {
    const payloadToSend: any = Object.assign({
      eventPrefix: targetPrefix,
      guild: currentG,
      allowEveryoneMention: true,
      payload: body
    }, body);
    delete payloadToSend.webhookUrl;
    delete payloadToSend.url;

    try {
      const invokeRes = await client.functions.invoke('discord-webhook-proxy', { body: payloadToSend });
      if (invokeRes && invokeRes.data && invokeRes.data.ok) return { ok: true };

      if (invokeRes && (invokeRes.error || (invokeRes.data && !invokeRes.data.ok))) {
        try {
          let authHeader = '';
          try {
            const sessRes = await client.auth.getSession();
            const token = sessRes && sessRes.data && sessRes.data.session && sessRes.data.session.access_token;
            if (token) authHeader = 'Bearer ' + token;
          } catch (_) { /* ignore */ }

          const rawHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY
          };
          if (authHeader) {
            rawHeaders['Authorization'] = authHeader;
          }

          const rawProxyRes = await fetch(SUPABASE_URL + '/functions/v1/discord-webhook-proxy', {
            method: 'POST',
            headers: rawHeaders,
            body: JSON.stringify(payloadToSend)
          });
          if (rawProxyRes && typeof rawProxyRes.json === 'function') {
            const rawData = await rawProxyRes.json();
            if (rawData && rawData.ok) return { ok: true };
            return { ok: false, error: rawData ? rawData.error : 'Unknown proxy fallback error' };
          }
        } catch (eRaw) {
          console.warn('Direct apikey proxy fallback failed:', eRaw);
        }
      }

      if (invokeRes && invokeRes.data && invokeRes.data.error) return { ok: false, error: invokeRes.data.error };
      if (invokeRes && invokeRes.error) return { ok: false, error: invokeRes.error.message || invokeRes.error };
      return { ok: false, error: 'Unknown error from invoke' };
    } catch (eProxy: any) {
      console.warn('Edge Function proxy invoke failed, trying direct fetch fallback:', eProxy);
      return { ok: false, error: eProxy.message || eProxy };
    }
  }

  // Never post to Discord from the browser. The proxy resolves the webhook
  // server-side, enforces the caller's guild and rate-limits; a direct POST
  // would bypass all three (audit ARC-04), and the CSP no longer allows it.
  return { ok: false, error: 'proxy_unavailable' };
}

/** Boolean convenience wrapper. */
export async function sendDiscordWebhook(eventPrefix: string, body: any): Promise<boolean> {
  const res = await sendDiscordWebhookDetailed(eventPrefix, body);
  return res.ok;
}

/** Builds and sends an event start/edit/reminder notification. */
export async function notifyDiscordEvent(eventName: string, eventStart: string, action: string): Promise<void> {
  if (!getClient()) return;

  let eventPrefix = '';
  const nameUpper = String(eventName || '').toUpperCase();
  if (nameUpper.indexOf('ARMS RACE') !== -1) eventPrefix = 'armsrace';
  else if (nameUpper.indexOf('TRADE ROUTE') !== -1 || nameUpper.indexOf('DTR') !== -1) eventPrefix = 'dtr';
  else if (nameUpper.indexOf('SHADOWFRONT') !== -1) eventPrefix = 'shadowfront';
  else if (nameUpper.indexOf('CALAMITY') !== -1) eventPrefix = 'calamity';
  else if (nameUpper.indexOf('GVG') !== -1) eventPrefix = 'gvg';
  else if (nameUpper.indexOf('SVS') !== -1) eventPrefix = 'svs';

  if (!webhookChainIsSet(await configuredWebhooks(), eventPrefix)) return;

  if ((action === 'start' || action === 'edit') && eventPrefix) {
    const creationEnabled = await getGuildConfig('notify_' + eventPrefix + '_creation');
    if (creationEnabled === 'false' || creationEnabled === false) return;
  }

  const dateObj = new Date(eventStart);
  const dateFormatted = !isNaN(dateObj.getTime())
    ? dateObj.toLocaleString('en-US', {
        weekday: 'short', month: '2-digit', day: '2-digit', timeZone: 'UTC',
        hour: '2-digit', minute: '2-digit', hour12: false
      } as any) + ' UTC'
    : String(eventStart);

  let eventSpecificRoleId: any = null;
  if (eventName === 'Shadowfront Squad 1') {
    eventSpecificRoleId = await getGuildConfig('discord_role_id_shadowfront_squad1') || await getGuildConfig('discord_role_id_shadowfront');
  } else if (eventName === 'Shadowfront Squad 2') {
    eventSpecificRoleId = await getGuildConfig('discord_role_id_shadowfront_squad2') || await getGuildConfig('discord_role_id_shadowfront');
  } else if (eventPrefix) {
    eventSpecificRoleId = await getGuildConfig('discord_role_id_' + eventPrefix);
  }
  const globalRoleId = await getGuildConfig('discord_role_id');
  const discordRoleId = (eventSpecificRoleId && eventSpecificRoleId.trim() !== '') ? eventSpecificRoleId : globalRoleId;
  const eventGuildTag = formatDiscordRoleMention(discordRoleId);

  let actionLabel = '';
  let content = '📢 **Guild Event Update:** ' + eventName + ' (' + action + ') ' + eventGuildTag;
  let embedTitle = '📢 Guild Event: ' + eventName;
  let embedDesc = 'A guild event schedule has been updated in the FGF Guild Management tool!';
  let color = 5763719; // Green

  if (action === 'start') {
    actionLabel = '🚀 Scheduled / Live';
    color = 5763719;
  } else if (action === 'edit') {
    actionLabel = '📅 Schedule Updated';
    color = 16750848;
  } else if (action === 'reminder_30') {
    content = '⏰ **Reminder:** ' + eventName + ' starts in **30 minutes**! ' + eventGuildTag;
    embedTitle = '⏰ Reminder: ' + eventName + ' starts in 30 minutes!';
    embedDesc = 'Get ready, soldiers! Please log in and prepare for the event.';
    color = 16750848;
  } else if (action === 'reminder_5') {
    content = '🚨 **Immediate Reminder:** ' + eventName + ' starts in **5 minutes**! Get ready! ' + eventGuildTag;
    embedTitle = '🚨 Immediate Reminder: ' + eventName + ' starts in 5 minutes!';
    embedDesc = 'Action time! Join your squad now!';
    color = 15548997;
  }

  if (action !== 'edit') {
    const customContent = await getGuildConfig('tpl_' + eventPrefix + '_' + action + '_content');
    const customTitle = await getGuildConfig('tpl_' + eventPrefix + '_' + action + '_title');
    const customDesc = await getGuildConfig('tpl_' + eventPrefix + '_' + action + '_desc');

    const replacePlaceholders = (str: string): string => {
      if (!str) return str;
      return str
        .replace(/@{guild_tag}/g, '{guild_tag}')
        .replace(/{event_name}/g, eventName)
        .replace(/{date}/g, dateFormatted)
        .replace(/{guild_tag}/g, eventGuildTag)
        .replace(/<@(\d{15,22})>/g, '<@&$1>')
        .replace(/(^|\s)@(\d{15,22})($|\s)/g, '$1<@&$2>$3');
    };

    if (customContent && customContent.trim() !== '') content = replacePlaceholders(customContent);
    if (customTitle && customTitle.trim() !== '') embedTitle = replacePlaceholders(customTitle);
    if (customDesc && customDesc.trim() !== '') embedDesc = replacePlaceholders(customDesc);
  }

  const fields: any[] = [];
  if (actionLabel) fields.push({ name: 'Status', value: actionLabel, inline: true });
  fields.push({ name: 'Start Time (UTC)', value: dateFormatted, inline: true });
  fields.push({ name: 'Guild Agenda', value: action.indexOf('reminder') !== -1 ? 'Please connect now.' : 'Please prepare and be ready at the scheduled time.', inline: false });

  const body = {
    content: content,
    allowed_mentions: { parse: ['roles', 'users', 'everyone'] },
    embeds: [{
      title: embedTitle,
      description: embedDesc,
      color: color,
      fields: fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'FGF Guild Management Tool' }
    }]
  };

  await sendDiscordWebhook(eventPrefix, body);
}

/** Sends a test notification embed to Discord for validation / diagnosis. */
export async function testDiscordWebhook(eventPrefix = 'general'): Promise<{ ok: boolean; error?: string }> {
  const currentG = getActiveGuild();
  const roleId = await getGuildConfig(eventPrefix && eventPrefix !== 'general' ? `discord_role_id_${eventPrefix}` : 'discord_role_id');
  const roleMention = formatDiscordRoleMention(roleId);

  const payload = {
    content: `🔔 **Test Notification** from FGF Guild Management (${currentG}) ${roleMention}`,
    embeds: [{
      title: '✅ Discord Webhook Test Successful',
      description: `Webhook integration is functioning properly for **${currentG}**${eventPrefix && eventPrefix !== 'general' ? ` (channel: ${eventPrefix})` : ''}.`,
      color: 5763719, // Green
      fields: [
        { name: 'Channel / Event', value: eventPrefix || 'general', inline: true },
        { name: 'Role Mention', value: roleMention, inline: true },
        { name: 'Timestamp (UTC)', value: new Date().toISOString(), inline: false }
      ],
      footer: { text: 'FGF Guild Management Tool • Webhook Test' }
    }],
    allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
  };

  const targetPrefix = (!eventPrefix || eventPrefix === 'general') ? '' : eventPrefix;
  const res = await sendDiscordWebhookDetailed(targetPrefix, payload);
  if (res.ok) return { ok: true };
  return { ok: false, error: typeof res.error === 'string' ? res.error : JSON.stringify(res.error || 'Unknown error') };
}
