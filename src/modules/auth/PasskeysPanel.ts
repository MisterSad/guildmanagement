/**
 * src/modules/auth/PasskeysPanel.ts
 *
 * Strangler Phase 1 port of the "My Passkeys" UI from the root
 * `gm-webauthn.js` — shared by the admin Accounts & Access panel and the
 * player Portal Security section. Exposes `mountPasskeysPanel(config)` and
 * `downloadBackupCodes(codes, accountId)`.
 *
 * This module never assigns `window.GM.webauthn` (bridge added at cutover).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  isSupported,
  registerPasskey,
  listPasskeys,
  renamePasskey,
  removePasskey,
  regenerateBackupCodes
} from '../../core/auth/webauthn.service';
import { escapeHTML } from '../../core/utils/text';

export interface PasskeysPanelConfig {
  listEl: HTMLElement | null;
  addBtnEl: HTMLButtonElement | null;
  regenBtnEl?: HTMLElement | null;
  regenLabelEl?: HTMLElement | null;
}

export interface PasskeysPanelHandle {
  reload: () => Promise<void>;
}

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

function esc(value: unknown): string {
  return escapeHTML(value);
}

function toast(msg: string, type: string): void {
  const g = gm();
  if (g && typeof g.showToast === 'function') g.showToast(msg, type);
}

function confirmDialog(title: string, html: string, onConfirm: () => void): void {
  const w = winAny();
  if (typeof w.showConfirm === 'function') w.showConfirm(title, html, onConfirm);
  else if (w.confirm ? w.confirm(title) : true) onConfirm();
}

export function formatPasskeyDate(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Triggers a browser download of the backup codes as a plain-text file. */
export function downloadBackupCodes(codes: string[], accountId?: string | null): void {
  const lines = [
    'FGF Guild Management Tool — Backup Codes',
    'Account: ' + (accountId || ''),
    'Generated: ' + new Date().toISOString(),
    '',
    'Each code can be used once to sign in if you lose access to all',
    'of your passkeys. Keep this file somewhere safe.',
    ''
  ].concat(codes);
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fgf-backup-codes' + (accountId ? '-' + accountId : '') + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
}

/**
 * Mounts the passkeys card. Returns { reload } — callers decide when the first
 * load happens (mounting itself makes no network call).
 */
export function mountPasskeysPanel(config: PasskeysPanelConfig): PasskeysPanelHandle {
  const listEl = config.listEl;
  const addBtnEl = config.addBtnEl;
  const regenBtnEl = config.regenBtnEl || null;
  const regenLabelEl = config.regenLabelEl || null;

  let lastPasskeys: any[] = [];
  let lastBackupCodesRemaining = 0;

  function render(passkeys: any[], backupCodesRemaining: number): void {
    if (!listEl) return;

    if (regenBtnEl) {
      regenBtnEl.classList.toggle('hidden', passkeys.length === 0);
      if (regenLabelEl) {
        regenLabelEl.textContent = backupCodesRemaining > 0
          ? 'Regenerate Backup Codes (' + backupCodesRemaining + ' left)'
          : 'Generate Backup Codes';
      }
    }

    if (!passkeys.length) {
      listEl.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-fingerprint gm-icon"></i><div class="gm-empty-title">No passkeys yet</div></div>';
      return;
    }

    let html = '<div class="gm-cred-grid">';
    passkeys.forEach((pk) => {
      html +=
        '<div class="gm-cred-card" data-passkey-id="' + esc(pk.id) + '">' +
          '<div class="gm-row" style="justify-content:space-between; align-items:center; margin-bottom: 0.25rem; gap:.5rem;">' +
            '<div class="gm-passkey-label-wrap" style="display:flex; align-items:center; gap:.4rem; flex:1; min-width:0;">' +
              '<i class="ph ph-fingerprint" style="color:var(--accent); flex-shrink:0;"></i>' +
              '<span class="gm-passkey-label" style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(pk.device_label) + '</span>' +
            '</div>' +
            '<div class="gm-row" style="gap:.25rem; flex-shrink:0;">' +
              '<button type="button" class="gm-mini-btn gm-passkey-rename" title="Rename"><i class="ph ph-pencil-simple"></i></button>' +
              '<button type="button" class="gm-mini-btn gm-danger gm-passkey-remove" title="Remove"><i class="ph ph-trash"></i></button>' +
            '</div>' +
          '</div>' +
          '<div class="gm-row gm-dim" style="font-size:.75rem; gap:.75rem;">' +
            '<span><i class="ph ph-calendar-blank"></i> Added ' + formatPasskeyDate(pk.created_at) + '</span>' +
            '<span><i class="ph ph-clock"></i> ' + (pk.last_used_at ? 'Last used ' + formatPasskeyDate(pk.last_used_at) : 'Never used') + '</span>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    listEl.innerHTML = html;

    listEl.querySelectorAll('.gm-passkey-rename').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.gm-cred-card') as HTMLElement | null;
        if (!card) return;
        const id = card.getAttribute('data-passkey-id') || '';
        const wrap = card.querySelector('.gm-passkey-label-wrap') as HTMLElement | null;
        const current = (card.querySelector('.gm-passkey-label')?.textContent) || '';
        if (!wrap) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'gm-input';
        input.value = current;
        input.maxLength = 100;
        input.style.cssText = 'flex:1; min-width:0; padding:.25rem .5rem; font-size:.9rem;';
        wrap.innerHTML = '';
        wrap.appendChild(input);
        input.focus();
        input.select();

        let settled = false;
        const commit = async (): Promise<void> => {
          if (settled) return;
          settled = true;
          const newLabel = input.value.trim();
          if (!newLabel || newLabel === current) {
            render(lastPasskeys, lastBackupCodesRemaining);
            return;
          }
          try {
            const res = await renamePasskey(id, newLabel);
            if (!res.ok) throw new Error(res.error || 'rename_failed');
            toast('Passkey renamed.', 'success');
            void reload();
          } catch (err: any) {
            toast('Could not rename passkey: ' + err.message, 'error');
            render(lastPasskeys, lastBackupCodesRemaining);
          }
        };
        const cancel = (): void => {
          if (settled) return;
          settled = true;
          render(lastPasskeys, lastBackupCodesRemaining);
        };
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); void commit(); }
          else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', () => { void commit(); });
      });
    });

    listEl.querySelectorAll('.gm-passkey-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.gm-cred-card') as HTMLElement | null;
        if (!card) return;
        const id = card.getAttribute('data-passkey-id') || '';
        const label = (card.querySelector('.gm-passkey-label')?.textContent) || '';
        confirmDialog(
          'Remove Passkey',
          'Remove <strong>' + esc(label) + '</strong>? You won\'t be able to sign in with this device\'s passkey anymore. Your password will still work.',
          async () => {
            try {
              const res = await removePasskey(id);
              if (!res.ok) throw new Error(res.error || 'remove_failed');
              toast('Passkey removed.', 'success');
              void reload();
            } catch (err: any) {
              toast('Could not remove passkey: ' + err.message, 'error');
            }
          }
        );
      });
    });
  }

  function showBackupCodesDialog(codes: string[]): void {
    const existing = document.getElementById('backup-codes-overlay');
    if (existing) existing.remove();

    const accountId = (gm() && gm().currentAccountId) || localStorage.getItem('gm_user') || '';
    const codesHtml = codes.map((c) =>
      '<div style="padding:.35rem .5rem; background:rgba(255,255,255,0.04); border-radius:4px; text-align:center; letter-spacing:.03em;">' + esc(c) + '</div>'
    ).join('');

    const html =
      '<div id="backup-codes-overlay" class="gm-modal-overlay">' +
        '<div class="gm-modal-card" style="max-width: 480px; width: 92%;">' +
          '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom: .75rem;">' +
            '<i class="ph ph-shield-check" style="font-size: 1.5rem; color: var(--accent);"></i>' +
            '<h3 style="margin:0; font-size: 1.15rem;">Save Your Backup Codes</h3>' +
          '</div>' +
          '<p style="margin-top:0; color: var(--fg-dim); font-size:.9rem;">Each code works once, to sign in if you ever lose access to all your passkeys. This is the only time they\'ll be shown in full — download or copy them now.</p>' +
          '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:.4rem; font-family: monospace; font-size:.9rem; background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:.75rem; margin: .75rem 0;">' +
            codesHtml +
          '</div>' +
          '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
            '<button type="button" class="gm-btn gm-btn-ghost" id="backup-codes-close">I\'ve saved these</button>' +
            '<button type="button" class="gm-btn gm-btn-primary" id="backup-codes-download"><i class="ph ph-download-simple"></i> Download</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.insertAdjacentHTML('beforeend', html);
    const overlay = document.getElementById('backup-codes-overlay') as HTMLElement;
    winAny().requestAnimationFrame(() => { overlay.classList.add('visible'); });

    const closeModal = (): void => {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.remove(); }, 200);
    };
    const closeBtn = document.getElementById('backup-codes-close');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    const dlBtn = document.getElementById('backup-codes-download');
    if (dlBtn) dlBtn.addEventListener('click', () => { downloadBackupCodes(codes, accountId); });
  }

  const reload = async (): Promise<void> => {
    if (!listEl) return;
    const res = await listPasskeys();
    if (!res.ok) {
      listEl.innerHTML = '<div class="gm-empty"><div class="gm-empty-title">Could not load passkeys.</div></div>';
      return;
    }
    lastPasskeys = res.passkeys || [];
    lastBackupCodesRemaining = res.backupCodesRemaining || 0;
    render(lastPasskeys, lastBackupCodesRemaining);
  };

  if (addBtnEl) {
    if (!isSupported()) {
      addBtnEl.disabled = true;
      addBtnEl.title = 'Passkeys are not supported in this browser.';
    }
    addBtnEl.addEventListener('click', async () => {
      addBtnEl.disabled = true;
      const icon = addBtnEl.querySelector('i');
      const originalIconClass = icon ? icon.className : '';
      if (icon) icon.className = 'ph ph-circle-notch ph-spin';
      try {
        const res = await registerPasskey();
        if (!res.ok) {
          if (res.error === 'cancelled') {
            // User closed the browser's own passkey prompt — not an error.
          } else if (res.error === 'webauthn_unsupported') {
            toast('Passkeys are not supported in this browser.', 'error');
          } else {
            toast('Could not add passkey: ' + res.error, 'error');
          }
          return;
        }
        toast('Passkey added!', 'success');
        await reload();
        if (res.backupCodes && res.backupCodes.length) {
          showBackupCodesDialog(res.backupCodes);
        }
      } finally {
        addBtnEl.disabled = false;
        if (icon) icon.className = originalIconClass;
      }
    });
  }

  if (regenBtnEl) {
    regenBtnEl.addEventListener('click', () => {
      confirmDialog(
        'Regenerate Backup Codes',
        'This replaces your existing backup codes with a new set — any old codes will stop working. Continue?',
        async () => {
          try {
            const res = await regenerateBackupCodes();
            if (!res.ok) throw new Error(res.error || 'regenerate_failed');
            showBackupCodesDialog(res.backupCodes);
            void reload();
          } catch (err: any) {
            toast('Could not regenerate backup codes: ' + err.message, 'error');
          }
        }
      );
    });
  }

  return { reload };
}
