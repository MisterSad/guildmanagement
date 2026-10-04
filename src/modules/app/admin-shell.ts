/**
 * src/modules/app/admin-shell.ts
 *
 * The admin side of the app as one chunk (medium-term plan, M5): the shell
 * chrome, the tab router, and the accounts, members, banned and OCR
 * controllers. The sign-in screen and the player portal never download it; it
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

export { showAdminDashboard, reloadActiveView, restoreSavedTab } from './router';
export { fetchGuilds } from './admin/accounts.controller';
export { openOcrModal } from './ocr/ocr.controller';
export { shellView } from '../shell/views/ShellView';

let started = false;

/** Wires the admin forms, the tab router, the OCR triggers and the shell. Idempotent. */
export function startAdmin(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
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
