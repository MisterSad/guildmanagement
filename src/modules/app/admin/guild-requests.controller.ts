/**
 * src/modules/app/admin/guild-requests.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — guild requests review, guild settings, and pending
 * player registrations ported from app.js. XSS invariant preserved: every
 * request/pseudo/tag value is passed through esc(); confirmations go through
 * window.showConfirm and feedback through dialogs showToast.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { t, esc, gm, winAny, byId, getDb } from './utils';
import { type AccountRow, getAccounts, filterAccountsOut } from './admin-store';
import { fetchAccounts, fetchGuilds } from './accounts.controller';
import { showToast } from '../dialogs/dialogs.service';
import { initChestTiersSettings, loadChestTiers } from '../../events/chest-settings';

const GUILD_REQUEST_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'gm-chip-warning' },
  approved: { label: 'Approved', cls: 'gm-chip-success' },
  rejected: { label: 'Rejected', cls: 'gm-chip-danger' },
  expired: { label: 'Expired', cls: '' }
};

export async function fetchGuildRequests(): Promise<void> {
  const listEl = byId('guild-requests-list');
  const countEl = byId('guild-requests-pending-count');
  if (!listEl) return;
  try {
    const g = gm();
    const res = await g.adminAccounts('list-guild-requests', {});
    if (!res.ok) throw new Error(res.error || 'server_error');
    const requests = res.requests || [];
    const pendingCount = requests.filter((r: any) => r.status === 'pending').length;
    if (countEl) countEl.textContent = String(pendingCount);
    renderGuildRequestsList(requests);
  } catch (_err) {
    listEl.innerHTML = '<div class="gm-empty" style="padding:2rem 1rem;"><p style="color:var(--text-muted);">Failed to load guild requests.</p></div>';
  }
}

export function renderGuildRequestsList(requests: any[]): void {
  const listEl = byId('guild-requests-list');
  if (!listEl) return;

  if (!requests.length) {
    listEl.innerHTML = '<div class="gm-empty" style="padding:2rem 1rem;"><i class="ph ph-tray gm-icon"></i><div class="gm-empty-title">No guild requests yet</div></div>';
    return;
  }

  const html = requests.map((r) => {
    const meta = GUILD_REQUEST_STATUS_META[r.status] || { label: r.status, cls: '' };
    const dateStr = r.created_at
      ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '-';
    const noteHtml = r.note ? '<div style="color:var(--text-muted); font-size: var(--fs-sm); margin-top:.25rem;">' + esc(r.note) + '</div>' : '';
    let actionsHtml = '';
    if (r.status === 'pending') {
      actionsHtml =
        '<button class="gm-btn gm-btn-primary gm-btn-sm gm-guild-req-approve" data-id="' + esc(r.id) + '">' +
          '<i class="ph ph-check"></i><span>Approve</span>' +
        '</button>' +
        '<button class="gm-btn gm-btn-ghost gm-btn-sm gm-guild-req-reject" data-id="' + esc(r.id) + '">' +
          '<i class="ph ph-x"></i><span>Reject</span>' +
        '</button>';
    } else if (r.reject_reason) {
      actionsHtml = '<span style="color:var(--text-muted); font-size: var(--fs-sm);">' + esc(r.reject_reason) + '</span>';
    }

    return (
      '<div class="gm-card gm-card-padded" style="margin-bottom:.75rem;" data-request-id="' + esc(r.id) + '">' +
        '<div class="gm-row" style="justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:.5rem;">' +
          '<div>' +
            '<div class="gm-row" style="gap:.5rem; align-items:center;">' +
              '<strong>' + esc(r.guild_tag) + '</strong>' +
              '<span style="color:var(--text-muted); font-size: var(--fs-base);">#' + esc(r.server_number) + '</span>' +
              '<span class="gm-chip ' + meta.cls + '">' + esc(meta.label) + '</span>' +
            '</div>' +
            '<div style="color:var(--text-muted); font-size: var(--fs-base); margin-top:.25rem;">' +
              'Admin login: <strong>' + esc(r.admin_id) + '</strong> &middot; Discord: ' + esc(r.discord_handle) + ' &middot; ' + dateStr +
            '</div>' +
            noteHtml +
            '<div class="gm-guild-req-result" style="margin-top:.5rem;"></div>' +
          '</div>' +
          '<div class="gm-row" style="gap:.5rem;">' + actionsHtml + '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

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
      const w = winAny();
      if (!w.showConfirm) return;
      w.showConfirm(
        'Approve Guild Request',
        'Create guild <strong>' + esc(tag) + '</strong> and its first guild_admin account? A password will be generated for you to relay via Discord.',
        async () => {
          (btn as HTMLButtonElement).disabled = true;
          try {
            const g = gm();
            const res = await g.adminAccounts('approve-guild-request', { id });
            if (!res.ok) throw new Error(res.error || 'approve_failed');
            const resultEl = card ? card.querySelector('.gm-guild-req-result') : null;
            if (resultEl) {
              resultEl.innerHTML =
                '<div class="gm-cred-pass" style="display:inline-flex;">' +
                  '<span class="gm-pwd-text">' + esc(res.password) + '</span>' +
                  '<button class="gm-mini-btn gm-guild-req-copy" data-pass="' + esc(res.password) + '" title="Copy Password"><i class="ph ph-copy"></i></button>' +
                '</div>';
              const copyBtn = resultEl.querySelector('.gm-guild-req-copy');
              if (copyBtn) copyBtn.addEventListener('click', () => {
                if (navigator.clipboard) navigator.clipboard.writeText(res.password).then(() => { showToast('Password copied to clipboard.', 'success'); });
              });
            }
            if (navigator.clipboard) navigator.clipboard.writeText(res.password).catch(() => undefined);
            showToast('Guild ' + res.guild + ' created. Admin ' + res.id + ' — password copied to clipboard, relay it via Discord.', 'success');
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
      const w = winAny();
      if (!w.showConfirm) return;
      w.showConfirm(
        'Reject Guild Request',
        'Reject the request for <strong>' + esc(tag) + '</strong>? The tag and admin login will become available again.',
        async () => {
          (btn as HTMLButtonElement).disabled = true;
          try {
            const g = gm();
            const res = await g.adminAccounts('reject-guild-request', { id });
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

interface ConfigField { key: string; el: string; gated?: boolean; }
interface CheckboxField { key: string; el: string; def: boolean; gated?: boolean; }

const VALUE_FIELDS: ConfigField[] = [
  { key: 'coeff_svs', el: 'coeff-svs' },
  { key: 'coeff_gvg', el: 'coeff-gvg' },
  { key: 'coeff_shadowfront', el: 'coeff-shadowfront' },
  { key: 'coeff_dtr', el: 'coeff-dtr' },
  { key: 'coeff_armsrace', el: 'coeff-armsrace' },
  { key: 'webhook_armsrace', el: 'webhook-armsrace' },
  { key: 'webhook_dtr', el: 'webhook-dtr' },
  { key: 'webhook_shadowfront', el: 'webhook-shadowfront' },
  { key: 'webhook_calamity', el: 'webhook-calamity', gated: true },
  { key: 'webhook_gvg', el: 'webhook-gvg', gated: true },
  { key: 'webhook_svs', el: 'webhook-svs', gated: true },
  { key: 'discord_role_id', el: 'discord-role-id' },
  { key: 'discord_role_id_armsrace', el: 'discord-role-id-armsrace' },
  { key: 'discord_role_id_dtr', el: 'discord-role-id-dtr' },
  { key: 'discord_role_id_shadowfront', el: 'discord-role-id-shadowfront' },
  { key: 'discord_role_id_shadowfront_squad2', el: 'discord-role-id-shadowfront-squad2' },
  { key: 'discord_role_id_calamity', el: 'discord-role-id-calamity', gated: true },
  { key: 'discord_role_id_gvg', el: 'discord-role-id-gvg', gated: true },
  { key: 'discord_role_id_svs', el: 'discord-role-id-svs', gated: true },
  { key: 'discord_verification_channel_id', el: 'discord-verification-channel-id' }
];

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
  { key: 'notify_svs_won_prep', el: 'notify-svs-won-prep', def: false, gated: true }
];

async function configGet(key: string): Promise<string> {
  const g = gm();
  return g && g.config ? await g.config.get(key) : '';
}

function setChecked(id: string, value: string | null, defaultValue: boolean): void {
  const el = byId<HTMLInputElement>(id);
  if (!el) return;
  if (value === null || value === undefined || value === '') el.checked = defaultValue;
  else el.checked = (value === 'true' || value === '1');
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

  const tagSettingEl = byId<HTMLInputElement>('guild-tag-setting');
  if (tagSettingEl) {
    const g = gm();
    const currentTag = g && typeof g.getGuildTag === 'function' ? await g.getGuildTag() : '';
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
    const g = gm();
    const showCalamityGvgSvs = (await configGet('gvg_svs_calamity_enabled')) !== 'false';

    const tagSettingEl = byId<HTMLInputElement>('guild-tag-setting');
    let tagVal = '';
    if (tagSettingEl) {
      const rawTag = tagSettingEl.value.trim().toUpperCase();
      if (rawTag) tagVal = (!rawTag.startsWith('[') && !rawTag.endsWith(']')) ? '[' + rawTag + ']' : rawTag;
    }
    const serverNumVal = (byId<HTMLInputElement>('guild-server-number-setting')?.value || '').trim();

    const promises: Promise<void>[] = [
      g.config.set('guild_tag', tagVal),
      g.config.set('server_number', serverNumVal)
    ];
    for (const field of VALUE_FIELDS) {
      const el = byId<HTMLInputElement>(field.el);
      const value = el ? el.value.trim() : '';
      promises.push(g.config.set(field.key, (field.gated && !showCalamityGvgSvs) ? '' : value));
    }
    for (const field of CHECKBOX_FIELDS) {
      const el = byId<HTMLInputElement>(field.el);
      const checked = el ? el.checked : field.def;
      promises.push(g.config.set(field.key, (checked && (!field.gated || showCalamityGvgSvs)) ? 'true' : 'false'));
    }

    await Promise.all(promises);
    showToast(t('toast_config_updated'), 'success');
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = origText;
  }
}

// ── Pending player registrations ─────────────────────────────────────────────

export async function renderPendingRegistrations(activeG?: string): Promise<void> {
  const overviewContainer = byId('pending-account-list');
  const overviewCount = byId('pending-account-count');
  const adminContainer = byId('admin-pending-account-list');
  const adminCount = byId('admin-pending-account-count');
  if (!overviewContainer && !adminContainer) return;

  let guild = activeG;
  if (!guild) {
    const g = gm();
    guild = g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : 'ALPHA';
  }
  const activeGUpper = String(guild || '').trim().toUpperCase();

  let pending: AccountRow[] = [];
  const accounts = getAccounts();
  if (accounts && accounts.length > 0) {
    pending = accounts.filter((acc) => {
      const accGuildUpper = String(acc.guild || 'ALPHA').trim().toUpperCase();
      return acc.status === 'pending' && acc.role === 'member' && accGuildUpper === activeGUpper;
    });
  } else {
    const db = getDb();
    if (db) {
      try {
        const res = await db.from('accounts')
          .select('id, uid, status, role, guild, created_at')
          .eq('status', 'pending')
          .eq('role', 'member')
          .ilike('guild', guild);
        pending = res.data || [];
      } catch (e) {
        console.warn('[GM] Error loading pending accounts:', e);
      }
    }
  }

  if (overviewCount) overviewCount.textContent = String(pending.length);
  if (adminCount) adminCount.textContent = String(pending.length);

  const emptyHtml = '<div class="gm-empty" style="padding:1.25rem;"><i class="ph-duotone ph-hourglass gm-icon"></i><div class="gm-empty-title">No pending registrations</div></div>';

  const renderListTo = (container: HTMLElement | null): void => {
    if (!container) return;
    if (pending.length === 0) { container.innerHTML = emptyHtml; return; }

    let html = '<div class="gm-cred-grid">';
    pending.forEach((acc) => {
      const dateStr = acc.created_at
        ? new Date(acc.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '-';
      html +=
        '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
          '<div class="gm-row" style="justify-content:space-between; margin-bottom: 0.25rem;">' +
            '<div class="gm-cred-name" style="font-weight:700; color:var(--fg);">' + esc(acc.id) + '</div>' +
            '<span class="gm-chip gm-chip-warning">Pending</span>' +
          '</div>' +
          '<div class="gm-row gm-dim" style="font-size: var(--fs-sm); gap: 0.75rem;">' +
            '<span><i class="ph ph-identification-badge"></i> UID ' + esc(acc.uid || '?') + '</span>' +
            '<span><i class="ph ph-calendar-blank"></i> ' + dateStr + '</span>' +
          '</div>' +
          '<div class="gm-row" style="gap: 0.5rem; margin-top: 0.6rem;">' +
            '<button class="gm-btn gm-btn-sm gm-btn-success gm-pending-approve" data-id="' + esc(acc.id) + '">' +
              '<i class="ph ph-check"></i><span>Approve</span>' +
            '</button>' +
            '<button class="gm-btn gm-btn-sm gm-btn-danger-ghost gm-pending-reject" data-id="' + esc(acc.id) + '">' +
              '<i class="ph ph-x"></i><span>Reject</span>' +
            '</button>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.gm-pending-approve').forEach((btn) => {
      btn.addEventListener('click', () => { void resolveRegistration(btn.getAttribute('data-id') || '', 'approve'); });
    });
    container.querySelectorAll('.gm-pending-reject').forEach((btn) => {
      btn.addEventListener('click', () => { void resolveRegistration(btn.getAttribute('data-id') || '', 'reject'); });
    });
  };

  renderListTo(overviewContainer);
  renderListTo(adminContainer);
}

export async function resolveRegistration(id: string, action: 'approve' | 'reject'): Promise<void> {
  try {
    const g = gm();
    const res = await g.adminAccounts(action === 'approve' ? 'approve-registration' : 'reject-registration', { id });
    if (!res.ok) throw new Error(res.error || (action + '_failed'));
    filterAccountsOut(id);
    await fetchAccounts();
    const w = winAny();
    if (w.GM_OVERVIEW && typeof w.GM_OVERVIEW.load === 'function') {
      w.GM_OVERVIEW.load();
    } else {
      await renderPendingRegistrations();
    }
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
    refreshBtn.addEventListener('click', () => { void fetchGuildRequests(); });
  }

  const clearBtn = byId<HTMLButtonElement>('guild-requests-clear-history-btn');
  if (clearBtn && !(clearBtn as any).__gmAdminWired) {
    (clearBtn as any).__gmAdminWired = true;
    clearBtn.addEventListener('click', () => {
      const w = winAny();
      if (!w.showConfirm) return;
      w.showConfirm(
        'Clear Guild Request History',
        'Remove every already-approved or already-rejected guild request from this list? Pending requests are never affected. This cannot be undone.',
        async () => {
          clearBtn.disabled = true;
          try {
            const g = gm();
            const res = await g.adminAccounts('clear-resolved-guild-requests', {});
            if (!res.ok) throw new Error(res.error || 'clear_failed');
            showToast(res.count > 0 ? ('Cleared ' + res.count + ' resolved request(s).') : 'No resolved requests to clear.', 'success');
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
    settingsForm.addEventListener('submit', (e) => { void onGuildSettingsSubmit(e); });
  }
}
