/**
 * src/modules/app/admin-shell.ts
 *
 * The admin side of the app as one chunk (medium-term plan, M5): the shell
 * chrome, the tab router, the accounts, members, banned and OCR controllers,
 * and the admin markup itself (the tab panels and the OCR modal). The sign-in screen and the player portal never download it; it
 * is imported through loadAdmin() (admin-loader.ts) once an admin session is
 * known, and startAdmin() then does the wiring main.ts used to do for everyone
 * at boot.
 */

import { initTabNavigation } from './router';
import { initAccountsUi } from './admin/accounts.controller';
import { initGuildRequestsUi } from './admin/guild-requests.controller';
import { initMembersUi } from './members/members.controller';
import { initBannedUi } from './members/banned.controller';
import { openOcrModal, initOcrDropdown, initTimezoneCollapsible } from './ocr/ocr.controller';
import { shellView } from '../shell/views/ShellView';
import { applyTranslations } from '../../core/i18n/i18n';
import adminPanelsHtml from './admin-panels.html?raw';
import ocrModalHtml from './ocr-modal.html?raw';

export { showAdminDashboard, reloadActiveView, restoreSavedTab } from './router';
export { fetchGuilds } from './admin/accounts.controller';
export { openOcrModal } from './ocr/ocr.controller';
export { shellView } from '../shell/views/ShellView';

let started = false;

/**
 * Puts the admin markup into the page (2026-10-04). The 16 tab panels and the
 * OCR modal used to ship in index.html to every visitor -- 148 KB of the page
 * that the sign-in screen and the player portal never show. They live in this
 * chunk now, and land exactly where they were: each slot index.html keeps is
 * replaced by its fragment, so the DOM is the one the page used to parse. It
 * must run before anything below looks for an admin element; the shell, for
 * one, adopts the panels that are direct children of #dashboard-view.
 */
function mountAdminMarkup(): void {
  const mounts: Array<[string, string]> = [
    ['admin-panels-slot', adminPanelsHtml],
    ['admin-ocr-slot', ocrModalHtml],
  ];
  for (const [slotId, html] of mounts) {
    const slot = document.getElementById(slotId);
    if (!slot) throw new Error(`admin markup slot #${slotId} is missing from index.html`);
    slot.insertAdjacentHTML('beforebegin', html.replace(/\n$/, ''));
    slot.remove();
  }
}

/** Wires the admin forms, the tab router, the OCR triggers and the shell. Idempotent. */
export function startAdmin(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  mountAdminMarkup();
  initTabNavigation();
  initAccountsUi();
  initGuildRequestsUi();
  initMembersUi();
  initBannedUi();
  initOcrDropdown();
  initTimezoneCollapsible();
  shellView.init();
  // The shell renders new markup; translate it like the rest of the page.
  applyTranslations();
  // Former app.js document-level OCR trigger delegation. Without it the
  // .btn-ocr-trigger dropdown/menu buttons would no longer open the modal.
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    const btn = target instanceof HTMLElement ? target.closest('.btn-ocr-trigger') : null;
    if (!btn) return;
    const metric = btn.getAttribute('data-metric') || 'members';
    void openOcrModal(metric);
  });
}
