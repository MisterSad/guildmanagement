/**
 * src/modules/app/admin/guild-requests.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — guild requests review, guild settings, and pending
 * player registrations ported from app.js. XSS invariant preserved: every
 * request/pseudo/tag value is passed through esc(); confirmations go through
 * showConfirm and feedback through dialogs showToast.
 */

import { overviewViewLazy } from '../lazy-views';
import { getActiveGuild } from '../../../core/auth/roles';
import { adminAccounts } from '../../../core/auth/session';
import { config, getGuildTag } from '../../../core/config/guild-config';
import { t, esc, byId, getDb } from './utils';
import { type AccountRow, getAccounts, filterAccountsOut } from './admin-store';
import { fetchAccounts, fetchGuilds } from './accounts.controller';
import { showToast, showConfirm, openCustomMsgModal } from '../dialogs/dialogs.service';
import { initChestTiersSettings, loadChestTiers } from '../../events/chest-settings';
import {
  testDiscordWebhook,
  formatDiscordRoleMention,
  sendDiscordWebhookDetailed,
  configuredWebhooks,
  setDiscordWebhook,
} from '../../../core/integrations/discord';
import { buildGvgDailyTaskEmbed } from '../../../core/config/gvg-tasks';
import { queryPendingMemberAccounts } from './admin.service';

const GUILD_REQUEST_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'gm-chip-warning' },
  approved: { label: 'Approved', cls: 'gm-chip-success' },
  rejected: { label: 'Rejected', cls: 'gm-chip-danger' },
  expired: { label: 'Expired', cls: '' },
};

export async function fetchGuildRequests(): Promise<void> {
  const listEl = byId('guild-requests-list');
  const countEl = byId('guild-requests-pending-count');
  if (!listEl) return;
  try {
    const res = await adminAccounts('list-guild-requests', {});
    if (!res.ok) throw new Error(res.error || 'server_error');
    const requests = res.requests || [];
    const pendingCount = requests.filter((r: any) => r.status === 'pending').length;
    if (countEl) countEl.textContent = String(pendingCount);
    renderGuildRequestsList(requests);
  } catch (_err) {
    listEl.innerHTML =
      '<div class="u-p-2rem-1rem gm-empty"><p class="u-c-text-muted">Failed to load guild requests.</p></div>';
  }
}

export function renderGuildRequestsList(requests: any[]): void {
  const listEl = byId('guild-requests-list');
  if (!listEl) return;

  if (!requests.length) {
    listEl.innerHTML =
      '<div class="u-p-2rem-1rem gm-empty"><i class="ph ph-tray gm-icon"></i><div class="gm-empty-title">No guild requests yet</div></div>';
    return;
  }

  const html = requests
    .map((r) => {
      const meta = GUILD_REQUEST_STATUS_META[r.status] || { label: r.status, cls: '' };
      const dateStr = r.created_at
        ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '-';
      const noteHtml = r.note ? '<div class="u-c-text-muted u-fs-fs-sm u-mt-0_25rem">' + esc(r.note) + '</div>' : '';
      let actionsHtml = '';
      if (r.status === 'pending') {
        actionsHtml =
          '<button class="gm-btn gm-btn-primary gm-btn-sm gm-guild-req-approve" data-id="' +
          esc(r.id) +
          '">' +
          '<i class="ph ph-check"></i><span>Approve</span>' +
          '</button>' +
          '<button class="gm-btn gm-btn-ghost gm-btn-sm gm-guild-req-reject" data-id="' +
          esc(r.id) +
          '">' +
          '<i class="ph ph-x"></i><span>Reject</span>' +
          '</button>';
      } else if (r.reject_reason) {
        actionsHtml = '<span class="u-c-text-muted u-fs-fs-sm">' + esc(r.reject_reason) + '</span>';
      }

      return (
        '<div class="u-mb-0_75rem gm-card gm-card-padded" data-request-id="' +
        esc(r.id) +
        '">' +
        '<div class="u-justify-space-between u-items-flex-start u-wrap-wrap u-gap-0_5rem gm-row">' +
        '<div>' +
        '<div class="u-gap-0_5rem u-items-center gm-row">' +
        '<strong>' +
        esc(r.guild_tag) +
        '</strong>' +
        '<span class="u-c-text-muted u-fs-fs-base">#' +
        esc(r.server_number) +
        '</span>' +
        '<span class="gm-chip ' +
        meta.cls +
        '">' +
        esc(meta.label) +
        '</span>' +
        '</div>' +
        '<div class="u-c-text-muted u-fs-fs-base u-mt-0_25rem">' +
        'Admin login: <strong>' +
        esc(r.admin_id) +
        '</strong> &middot; Discord: ' +
        esc(r.discord_handle) +
        ' &middot; ' +
        dateStr +
        '</div>' +
        noteHtml +
        '<div class="u-mt-0_5rem gm-guild-req-result"></div>' +
        '</div>' +
        '<div class="u-gap-0_5rem gm-row">' +
        actionsHtml +
        '</div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  listEl.innerHTML = html;
  wireGuildRequestListeners(listEl);
}

export function wireGuildRequestListeners(container: HTMLElement): void {
  container.querySelectorAll('.gm-guild-req-approve').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') || '';
      const card = btn.closest('[data-request-id]');
      const strong = card ? card.querySelector('strong') : null;
      const tag = strong ? strong.textContent || '' : 'this guild';
      showConfirm(
        'Approve Guild Request',
        'Create guild <strong>' +
          esc(tag) +
          '</strong> and its first guild_admin account? A password will be generated for you to relay via Discord.',
        async () => {
          (btn as HTMLButtonElement).disabled = true;
          try {
            const res = await adminAccounts('approve-guild-request', { id });
            if (!res.ok) throw new Error(res.error || 'approve_failed');
            const resultEl = card ? card.querySelector('.gm-guild-req-result') : null;
            if (resultEl) {
              resultEl.innerHTML =
                '<div class="u-d-inline-flex gm-cred-pass">' +
                '<span class="gm-pwd-text">' +
                esc(res.password) +
                '</span>' +
                '<button class="gm-mini-btn gm-guild-req-copy" data-pass="' +
                esc(res.password) +
                '" title="Copy Password"><i class="ph ph-copy"></i></button>' +
                '</div>';
              const copyBtn = resultEl.querySelector('.gm-guild-req-copy');
              if (copyBtn)
                copyBtn.addEventListener('click', () => {
                  if (navigator.clipboard)
                    navigator.clipboard.writeText(res.password).then(() => {
                      showToast('Password copied to clipboard.', 'success');
                    });
                });
            }
            if (navigator.clipboard) navigator.clipboard.writeText(res.password).catch(() => undefined);
            showToast(
              'Guild ' +
                res.guild +
                ' created. Admin ' +
                res.id +
                ' — password copied to clipboard, relay it via Discord.',
              'success'
            );
            await fetchGuilds();
            await fetchGuildRequests();
          } catch (err: any) {
            showToast('Could not approve request: ' + err.message, 'error');
            (btn as HTMLButtonElement).disabled = false;
          }
        }
      );
    });
  });

  container.querySelectorAll('.gm-guild-req-reject').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') || '';
      const card = btn.closest('[data-request-id]');
      const strong = card ? card.querySelector('strong') : null;
      const tag = strong ? strong.textContent || '' : 'this request';
      showConfirm(
        'Reject Guild Request',
        'Reject the request for <strong>' +
          esc(tag) +
          '</strong>? The tag and admin login will become available again.',
        async () => {
          (btn as HTMLButtonElement).disabled = true;
          try {
            const res = await adminAccounts('reject-guild-request', { id });
            if (!res.ok) throw new Error(res.error || 'reject_failed');
            showToast('Guild request rejected.', 'success');
            await fetchGuildRequests();
          } catch (err: any) {
            showToast('Could not reject request: ' + err.message, 'error');
            (btn as HTMLButtonElement).disabled = false;
          }
        }
      );
    });
  });
}

// ── Guild settings ───────────────────────────────────────────────────────────

interface ConfigField {
  key: string;
  el: string;
  gated?: boolean;
}
interface CheckboxField {
  key: string;
  el: string;
  def: boolean;
  gated?: boolean;
}

const VALUE_FIELDS: ConfigField[] = [
  { key: 'coeff_svs', el: 'coeff-svs' },
  { key: 'coeff_gvg', el: 'coeff-gvg' },
  { key: 'coeff_shadowfront', el: 'coeff-shadowfront' },
  { key: 'coeff_dtr', el: 'coeff-dtr' },
  { key: 'coeff_armsrace', el: 'coeff-armsrace' },
  { key: 'discord_role_id', el: 'discord-role-id' },
  { key: 'discord_role_id_armsrace', el: 'discord-role-id-armsrace' },
  { key: 'discord_role_id_dtr', el: 'discord-role-id-dtr' },
  { key: 'discord_role_id_shadowfront', el: 'discord-role-id-shadowfront' },
  { key: 'discord_role_id_shadowfront_squad2', el: 'discord-role-id-shadowfront-squad2' },
  { key: 'discord_role_id_calamity', el: 'discord-role-id-calamity', gated: true },
  { key: 'discord_role_id_gvg', el: 'discord-role-id-gvg', gated: true },
  { key: 'discord_role_id_svs', el: 'discord-role-id-svs', gated: true },
  { key: 'discord_verification_channel_id', el: 'discord-verification-channel-id' },
  { key: 'discord_audit_channel_id', el: 'discord-audit-channel-id' },
];

/**
 * ARC-04: webhook URLs are write-only from here. The form shows whether each
 * one is set, never its URL; typing a URL replaces it, "Remove" deletes it,
 * and an empty field leaves it as it is. Both go through the proxy, which
 * accepts Discord webhook URLs only.
 */
const WEBHOOK_FIELDS: ConfigField[] = [
  { key: 'discord_webhook_url', el: 'discord-webhook-url' },
  { key: 'webhook_armsrace', el: 'webhook-armsrace' },
  { key: 'webhook_dtr', el: 'webhook-dtr' },
  { key: 'webhook_shadowfront', el: 'webhook-shadowfront' },
  { key: 'webhook_calamity', el: 'webhook-calamity', gated: true },
  { key: 'webhook_gvg', el: 'webhook-gvg', gated: true },
  { key: 'webhook_svs', el: 'webhook-svs', gated: true },
];

// Short enough for the card's input (the long form was cut off mid-word); the
// full sentence is the field's tooltip.
const WEBHOOK_SET_PLACEHOLDER = 'Set — paste a URL to replace';
const WEBHOOK_SET_TITLE = 'A webhook is set. Paste a new URL to replace it.';

/** The webhook keys set when the form was last loaded. */
let configuredWebhookKeys: string[] = [];

function renderWebhookField(field: ConfigField, isSet: boolean): void {
  const input = byId<HTMLInputElement>(field.el);
  if (!input) return;
  if (!input.dataset.gmEmptyPlaceholder) input.dataset.gmEmptyPlaceholder = input.placeholder;
  input.value = '';
  input.placeholder = isSet ? WEBHOOK_SET_PLACEHOLDER : input.dataset.gmEmptyPlaceholder || '';
  input.title = isSet ? WEBHOOK_SET_TITLE : '';
  const wrapper = input.closest('.gm-ui-input') || input;
  let remove =
    wrapper.parentElement?.querySelector<HTMLButtonElement>(`button[data-gm-webhook-remove="${field.key}"]`) || null;
  if (!isSet) {
    remove?.remove();
    return;
  }
  if (remove) return;
  remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'gm-btn gm-btn-ghost gm-btn-sm';
  remove.dataset.gmWebhookRemove = field.key;
  remove.setAttribute('aria-label', 'Remove this webhook');
  remove.innerHTML = '<i class="ph ph-trash" aria-hidden="true"></i> <span>Remove</span>';
  remove.addEventListener('click', async () => {
    remove!.disabled = true;
    const res = await setDiscordWebhook(field.key, '');
    if (!res.ok) {
      remove!.disabled = false;
      showToast(t('toast_config_save_failed').replace('{n}', '1'), 'error');
      return;
    }
    configuredWebhookKeys = configuredWebhookKeys.filter((k) => k !== field.key);
    renderWebhookField(field, false);
  });
  wrapper.insertAdjacentElement('afterend', remove);
}

async function loadWebhookFields(): Promise<void> {
  configuredWebhookKeys = (await configuredWebhooks()) || [];
  for (const field of WEBHOOK_FIELDS) renderWebhookField(field, configuredWebhookKeys.indexOf(field.key) !== -1);
}

const CHECKBOX_FIELDS: CheckboxField[] = [
  { key: 'notify_armsrace_creation', el: 'notify-armsrace-creation', def: true },
  { key: 'notify_armsrace_reminder_30', el: 'notify-armsrace-30', def: true },
  { key: 'notify_armsrace_reminder_5', el: 'notify-armsrace-5', def: true },
  { key: 'notify_armsrace_start', el: 'notify-armsrace-start', def: true },
  { key: 'notify_dtr_creation', el: 'notify-dtr-creation', def: true },
  { key: 'notify_dtr_reminder_30', el: 'notify-dtr-30', def: true },
  { key: 'notify_dtr_reminder_5', el: 'notify-dtr-5', def: true },
  { key: 'notify_dtr_start', el: 'notify-dtr-start', def: true },
  { key: 'notify_shadowfront_creation', el: 'notify-shadowfront-creation', def: true },
  { key: 'notify_shadowfront_reminder_30', el: 'notify-shadowfront-30', def: true },
  { key: 'notify_shadowfront_reminder_5', el: 'notify-shadowfront-5', def: true },
  { key: 'notify_shadowfront_start', el: 'notify-shadowfront-start', def: true },
  { key: 'notify_calamity_10', el: 'notify-calamity-10', def: true, gated: true },
  { key: 'notify_gvg_daily_tasks', el: 'notify-gvg-daily-tasks', def: true, gated: true },
  { key: 'notify_gvg_pvp', el: 'notify-gvg-pvp', def: true, gated: true },
  { key: 'notify_svs_garrison', el: 'notify-svs-garrison', def: true, gated: true },
  { key: 'notify_svs_pvp', el: 'notify-svs-pvp', def: true, gated: true },
  { key: 'notify_svs_won_prep', el: 'notify-svs-won-prep', def: false, gated: true },
  // Opt-in (owner decision, 2026-09-27): a guild with no stored value keeps the
  // historical behaviour, where a Discord screenshot could create the roster
  // entry it was being checked against. Ticking it makes the roster the
  // authority -- see ADR-020.
  { key: 'discord_verification_require_roster', el: 'discord-verification-require-roster', def: false },
];

async function configGet(key: string): Promise<string> {
  return await config.get(key);
}

function setChecked(id: string, value: string | null, defaultValue: boolean): void {
  const el = byId<HTMLInputElement>(id);
  if (!el) return;
  if (value === null || value === undefined || value === '') el.checked = defaultValue;
  else el.checked = value === 'true' || value === '1';
  // gm-ui switches expose role="switch": keep aria-checked in sync so the
  // ARIA contract never drifts after legacy imperative reads/writes.
  if (el.getAttribute('role') === 'switch') {
    el.setAttribute('aria-checked', el.checked ? 'true' : 'false');
  }
}

/**
 * Warns while no officers (audit) channel is set. Without one, a Discord join
 * request is posted nowhere -- auth-discord skips it silently -- so new players
 * wait on officers who were never told, and the Approve / Reject buttons
 * never appear.
 */
function refreshAuditChannelWarning(): void {
  const input = byId<HTMLInputElement>('discord-audit-channel-id');
  const warning = byId('discord-audit-channel-warning');
  if (!input || !warning) return;
  warning.classList.toggle('hidden', input.value.trim() !== '');
  if (!(input as any).__gmAuditWarnWired) {
    (input as any).__gmAuditWarnWired = true;
    input.addEventListener('input', refreshAuditChannelWarning);
  }
}

export async function loadGuildSettings(): Promise<void> {
  const form = byId('guild-settings-form');
  if (!form) return;

  const showCalamityGvgSvs = (await configGet('gvg_svs_calamity_enabled')) !== 'false';
  for (const id of ['notification-group-calamity', 'notification-group-gvg', 'notification-group-svs']) {
    const group = byId(id);
    if (group) group.style.display = showCalamityGvgSvs ? '' : 'none';
  }

  for (const field of VALUE_FIELDS) {
    const value = await configGet(field.key);
    const el = byId<HTMLInputElement>(field.el);
    if (el) el.value = value || '';
  }
  for (const field of CHECKBOX_FIELDS) {
    setChecked(field.el, await configGet(field.key), field.def);
  }
  await loadWebhookFields();
  refreshAuditChannelWarning();

  const tagSettingEl = byId<HTMLInputElement>('guild-tag-setting');
  if (tagSettingEl) {
    const currentTag = await getGuildTag();
    tagSettingEl.value = currentTag || '';
  }
  const serverNumSettingEl = byId<HTMLInputElement>('guild-server-number-setting');
  if (serverNumSettingEl) serverNumSettingEl.value = (await configGet('server_number')) || '';

  initChestTiersSettings();
  await loadChestTiers();
}

async function onGuildSettingsSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  const origText = span ? span.textContent : '';
  if (span) span.textContent = '...';

  try {
    const showCalamityGvgSvs = (await configGet('gvg_svs_calamity_enabled')) !== 'false';

    const tagSettingEl = byId<HTMLInputElement>('guild-tag-setting');
    let tagVal = '';
    if (tagSettingEl) {
      const rawTag = tagSettingEl.value.trim().toUpperCase();
      if (rawTag) tagVal = !rawTag.startsWith('[') && !rawTag.endsWith(']') ? '[' + rawTag + ']' : rawTag;
    }
    const serverNumVal = (byId<HTMLInputElement>('guild-server-number-setting')?.value || '').trim();

    const promises: Promise<unknown>[] = [config.set('guild_tag', tagVal), config.set('server_number', serverNumVal)];
    for (const field of VALUE_FIELDS) {
      const el = byId<HTMLInputElement>(field.el);
      const value = el ? el.value.trim() : '';
      promises.push(config.set(field.key, field.gated && !showCalamityGvgSvs ? '' : value));
    }
    const webhookWrites: Array<{ field: ConfigField; url: string }> = [];
    for (const field of WEBHOOK_FIELDS) {
      const typed = (byId<HTMLInputElement>(field.el)?.value || '').trim();
      if (field.gated && !showCalamityGvgSvs) {
        // A disabled feature keeps no webhook, as before.
        if (configuredWebhookKeys.indexOf(field.key) !== -1) webhookWrites.push({ field, url: '' });
      } else if (typed) {
        webhookWrites.push({ field, url: typed });
      }
    }
    for (const w of webhookWrites) {
      promises.push(
        setDiscordWebhook(w.field.key, w.url).then((r) => {
          if (!r.ok && r.error === 'invalid_discord_webhook_url') {
            showToast('Not a Discord webhook URL: ' + w.field.key, 'error');
          }
          return r.ok;
        })
      );
    }
    for (const field of CHECKBOX_FIELDS) {
      const el = byId<HTMLInputElement>(field.el);
      const checked = el ? el.checked : field.def;
      promises.push(config.set(field.key, checked && (!field.gated || showCalamityGvgSvs) ? 'true' : 'false'));
    }

    // P0 audit RC1: never validate a save that silently failed (RLS, expired
    // session, offline DB). Each upsert reports its own result; any `false`
    // result upgrades to an explicit error toast instead of the success one.
    const results = await Promise.all(promises);
    const failures = results.filter((ok) => ok === false).length;
    if (failures > 0) {
      showToast(t('toast_config_save_failed').replace('{n}', String(failures)), 'error');
      return;
    }
    await loadWebhookFields();
    showToast(t('toast_config_updated'), 'success');
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = origText;
  }
}

// ── Pending player registrations ─────────────────────────────────────────────

export async function renderPendingRegistrations(activeG?: string | null): Promise<void> {
  const overviewContainer = byId('pending-account-list');
  const overviewCount = byId('pending-account-count');
  const adminContainer = byId('admin-pending-account-list');
  const adminCount = byId('admin-pending-account-count');
  if (!overviewContainer && !adminContainer) return;

  // H2: falls through to the canonical resolver, which returns null rather
  // than ALPHA. An unresolved tenant then matches no pending account.
  const guild = activeG || getActiveGuild();
  const activeGUpper = String(guild || '')
    .trim()
    .toUpperCase();

  let pending: AccountRow[] = [];
  const accounts = getAccounts();
  if (accounts && accounts.length > 0) {
    pending = accounts.filter((acc) => {
      const accGuildUpper = String(acc.guild || '')
        .trim()
        .toUpperCase();
      return acc.status === 'pending' && acc.role === 'member' && accGuildUpper === activeGUpper;
    });
  } else {
    const db = getDb();
    if (db) {
      try {
        const res = await queryPendingMemberAccounts(db, guild);
        pending = res.data || [];
      } catch (e) {
        console.warn('[GM] Error loading pending accounts:', e);
      }
    }
  }

  if (overviewCount) overviewCount.textContent = String(pending.length);
  if (adminCount) adminCount.textContent = String(pending.length);

  const emptyHtml =
    '<div class="u-p-1_25rem gm-empty"><i class="ph ph-hourglass gm-icon"></i><div class="gm-empty-title">No pending registrations</div></div>';

  const renderListTo = (container: HTMLElement | null): void => {
    if (!container) return;
    if (pending.length === 0) {
      container.innerHTML = emptyHtml;
      return;
    }

    let html = '<div class="gm-cred-grid">';
    pending.forEach((acc) => {
      const dateStr = acc.created_at
        ? new Date(acc.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '-';
      html +=
        '<div class="gm-cred-card" data-acc-id="' +
        esc(acc.id) +
        '">' +
        '<div class="u-justify-space-between u-mb-0_25rem gm-row">' +
        '<div class="u-fw-700 u-c-fg gm-cred-name">' +
        esc(acc.id) +
        '</div>' +
        '<span class="gm-chip gm-chip-warning">Pending</span>' +
        '</div>' +
        '<div class="u-fs-fs-sm u-gap-0_75rem gm-row gm-dim">' +
        '<span><i class="ph ph-identification-badge"></i> UID ' +
        esc(acc.uid || '?') +
        '</span>' +
        '<span><i class="ph ph-calendar-blank"></i> ' +
        dateStr +
        '</span>' +
        '</div>' +
        '<div class="u-gap-0_5rem u-mt-0_6rem gm-row">' +
        '<button class="gm-btn gm-btn-sm gm-btn-success gm-pending-approve" data-id="' +
        esc(acc.id) +
        '">' +
        '<i class="ph ph-check"></i><span>Approve</span>' +
        '</button>' +
        '<button class="gm-btn gm-btn-sm gm-btn-danger-ghost gm-pending-reject" data-id="' +
        esc(acc.id) +
        '">' +
        '<i class="ph ph-x"></i><span>Reject</span>' +
        '</button>' +
        '</div>' +
        '</div>';
    });
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.gm-pending-approve').forEach((btn) => {
      btn.addEventListener('click', () => {
        void resolveRegistration(btn.getAttribute('data-id') || '', 'approve');
      });
    });
    container.querySelectorAll('.gm-pending-reject').forEach((btn) => {
      btn.addEventListener('click', () => {
        void resolveRegistration(btn.getAttribute('data-id') || '', 'reject');
      });
    });
  };

  renderListTo(overviewContainer);
  renderListTo(adminContainer);
}

export async function resolveRegistration(id: string, action: 'approve' | 'reject'): Promise<void> {
  try {
    const res = await adminAccounts(action === 'approve' ? 'approve-registration' : 'reject-registration', { id });
    if (!res.ok) throw new Error(res.error || action + '_failed');
    filterAccountsOut(id);
    await fetchAccounts();
    // Phase 7: the Overview reload was a `window` probe with a fallback that
    // only ran when the namespace was missing -- i.e. never, in production.
    void overviewViewLazy.peek()?.load();
    showToast(action === 'approve' ? 'Player account approved.' : 'Player registration rejected.', 'success');
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

/** Wires the guild-requests toolbar + guild-settings form. Idempotent. */
export function initGuildRequestsUi(): void {
  const refreshBtn = byId<HTMLButtonElement>('guild-requests-refresh-btn');
  if (refreshBtn && !(refreshBtn as any).__gmAdminWired) {
    (refreshBtn as any).__gmAdminWired = true;
    refreshBtn.addEventListener('click', () => {
      void fetchGuildRequests();
    });
  }

  const clearBtn = byId<HTMLButtonElement>('guild-requests-clear-history-btn');
  if (clearBtn && !(clearBtn as any).__gmAdminWired) {
    (clearBtn as any).__gmAdminWired = true;
    clearBtn.addEventListener('click', () => {
      showConfirm(
        'Clear Guild Request History',
        'Remove every already-approved or already-rejected guild request from this list? Pending requests are never affected. This cannot be undone.',
        async () => {
          clearBtn.disabled = true;
          try {
            const res = await adminAccounts('clear-resolved-guild-requests', {});
            if (!res.ok) throw new Error(res.error || 'clear_failed');
            showToast(
              res.count > 0 ? 'Cleared ' + res.count + ' resolved request(s).' : 'No resolved requests to clear.',
              'success'
            );
            await fetchGuildRequests();
          } catch (err: any) {
            showToast('Could not clear history: ' + err.message, 'error');
          } finally {
            clearBtn.disabled = false;
          }
        }
      );
    });
  }

  const settingsForm = byId<HTMLFormElement>('guild-settings-form');
  if (settingsForm && !(settingsForm as any).__gmAdminWired) {
    (settingsForm as any).__gmAdminWired = true;
    settingsForm.addEventListener('submit', (e) => {
      void onGuildSettingsSubmit(e);
    });
  }

  const testDefaultBtn = byId<HTMLButtonElement>('btn-test-default-webhook');
  if (testDefaultBtn && !(testDefaultBtn as any).__gmAdminWired) {
    (testDefaultBtn as any).__gmAdminWired = true;
    testDefaultBtn.addEventListener('click', async () => {
      testDefaultBtn.disabled = true;
      const origText = testDefaultBtn.innerHTML;
      testDefaultBtn.textContent = 'Testing...';
      try {
        const res = await testDiscordWebhook('general');
        if (res.ok) {
          showToast('Discord test notification sent successfully!', 'success');
        } else {
          showToast('Discord test failed: ' + (res.error || 'Unknown error'), 'error');
        }
      } catch (err: any) {
        showToast('Discord test failed: ' + (err.message || 'Unknown error'), 'error');
      } finally {
        testDefaultBtn.disabled = false;
        testDefaultBtn.innerHTML = origText;
      }
    });
  }

  const gvgBtn = byId<HTMLButtonElement>('btn-dispatch-gvg-tasks');
  if (gvgBtn && !(gvgBtn as any).__gmAdminWired) {
    (gvgBtn as any).__gmAdminWired = true;
    gvgBtn.addEventListener('click', async () => {
      gvgBtn.disabled = true;
      const origHtml = gvgBtn.innerHTML;
      gvgBtn.textContent = 'Sending...';
      try {
        const now = new Date();
        let day = now.getUTCDay();
        if (day === 0) day = 1; // Default Sunday to Day 1
        const roleId = (
          byId<HTMLInputElement>('discord-role-id-gvg')?.value ||
          byId<HTMLInputElement>('discord-role-id')?.value ||
          ''
        ).trim();
        const roleMention = formatDiscordRoleMention(roleId);
        const payload = buildGvgDailyTaskEmbed(day, roleMention);
        const res = await sendDiscordWebhookDetailed('gvg', payload);
        if (res.ok) {
          showToast(`GvG Day ${day} tasks sent to Discord!`, 'success');
        } else {
          showToast(`Failed to send GvG tasks: ${res.error || 'Unknown error'}`, 'error');
        }
      } catch (err: any) {
        showToast('Error sending GvG tasks: ' + (err.message || 'Unknown error'), 'error');
      } finally {
        gvgBtn.disabled = false;
        gvgBtn.innerHTML = origHtml;
      }
    });
  }

  document.querySelectorAll<HTMLElement>('[data-custom-msg]').forEach((btn) => {
    if ((btn as any).__gmCustomMsgWired) return;
    (btn as any).__gmCustomMsgWired = true;
    btn.addEventListener('click', () => {
      const prefix = btn.getAttribute('data-custom-msg');
      if (prefix) void openCustomMsgModal(prefix);
    });
  });
}
