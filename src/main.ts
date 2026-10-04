/**
 * src/main.ts
 *
 * Primary application entrypoint for FGF Guild Management Tool: builds the
 * guarded Supabase client, wires the views, and boots the session.
 *
 * Since M4c the app installs nothing on `window` but one frozen object for the
 * e2e suite (GM_E2E, below). Modules import each other; the client, the state
 * and the dialogs are typed modules, not globals.
 */

// Core styles bundled & minified by Vite (cascade order: tokens -> theme -> styles -> components -> shell)
import { portalViewLazy } from './modules/app/lazy-views';
import '../tokens.css';
import '../theme.css';
import '../styles.css';
import '../components.css';
import '../shell.css';
import '@phosphor-icons/web/regular';
// Last: the classes that replaced index.html's inline styles (M5) must win ties.
import '../utilities.css';

import { applyTranslations } from './core/i18n/i18n';
import { setDbClient, handleSessionInvalidation, resetSessionInvalidationFlag } from './core/api/supabase';
import { configureFetchErrorRuntime } from './core/api/fetch-errors';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './core/config/constants';
import { installDbWriteGuard } from './core/api/db-guard';
import { runGmBootstrap } from './core/bootstrap';
import { initAppState } from './core/state/app-state';
import { helpView } from './modules/help/HelpView';
import { showConfirm, showToast as showAppToast } from './modules/app/dialogs/dialogs.service';
import { openDialog } from './components/ui/Dialog';
import {
  restoreSession,
  handleDiscordCallback,
  applyLinkIntentAtBoot,
  doLogout,
  initAuthForms,
} from './modules/app/auth/auth.controller';
import { captureIntentFromHash } from './core/auth/pending-intent';
import { initVersionCheck } from './modules/app/auth/version-check';
import { initNetworkStatusMonitoring } from './core/net/network-status';
import { initTooltips } from './components/ui/Tooltip';
import { initSentry } from './core/monitoring/sentry';
import { startStyleRefs } from './core/dom/style-refs';
import { loadAdmin } from './modules/app/admin-loader';
import { wireLoginPasswordToggle, wireSearchClearButtons } from './core/dom/form-controls';

// Crash reporting. The SDK is its own chunk (M5); errors thrown while it loads
// are held and reported once it is up.
void initSentry();

if (typeof window !== 'undefined') {
  // P3: build the client from hardcoded constants (never import.meta.env) and
  // install the multi-tenant write guard before any service runs.
  setDbClient(installDbWriteGuard(createClient(SUPABASE_URL, SUPABASE_KEY)));
  initAppState();
  // Computed styles of string-built markup, applied through the CSSOM: the CSP
  // has no 'unsafe-inline' for styles (core/dom/style-refs.ts). Before anything renders.
  startStyleRefs();

  // The app's ONLY global (owner decision, 2026-10-04). The e2e suite runs
  // against the real production bundle and needs to open a screen without a
  // real Discord sign-in; these five entry points are what it calls. Frozen
  // and non-writable: nothing can be added to it or swapped in it. It grants
  // nothing -- every request still goes through RLS with the caller's token.
  // window.GM, GM_APP, GM_OCR, GM_PORTAL and the 20 other GM_* namespaces it
  // replaces are gone (M4c); tests/gm_bridge_contract.test.js pins this list.
  Object.defineProperty(window, 'GM_E2E', {
    value: Object.freeze({
      showAdminDashboard: () => loadAdmin().then((a) => a.showAdminDashboard()),
      openOcrModal: (metric?: string) => loadAdmin().then((a) => a.openOcrModal(metric)),
      loadPortalDashboard: () => portalViewLazy.get().then((v) => v.loadDashboard()),
      openDialog,
      showConfirm,
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  document.addEventListener('DOMContentLoaded', () => {
    // Full cutover bootstrap order (app.js removed). gm-utils startup
    // side-effects (rad_* migration, window.currentGuild, terms modal) first.
    runGmBootstrap();
    // P3-01/P3-02: wire the shared fetch-error runtime (classified toasts +
    // session invalidation) and route the global session-expiry signal to
    // logout/re-login instead of per-view generic toasts.
    configureFetchErrorRuntime({
      showToast: showAppToast,
      onSessionInvalid: () => {
        handleSessionInvalidation();
      },
    });
    window.addEventListener('gm:session-expired', () => {
      void doLogout();
    });
    // Auth/session form wiring and stale-tab detection. The admin forms, tab
    // router, OCR triggers and shell are wired by startAdmin() when the admin
    // chunk loads (M5); the sign-in screen and the portal never download it.
    initAuthForms();
    initVersionCheck();
    initNetworkStatusMonitoring();
    // Sign-in screen controls: the password eye and the search clear buttons.
    wireLoginPasswordToggle();
    wireSearchClearButtons();
    helpView.init();
    // i18n single pass over the complete dictionary once the DOM is ready.
    applyTranslations();
    // Declarative gm-ui tooltips over [data-tooltip] elements.
    initTooltips();
    // A Discord sign-in returns here carrying a one-time ticket in the URL, and
    // must be handled BEFORE the ordinary restore: it installs a session, so
    // letting restoreSession win the race would settle the page into a
    // logged-out state with the ticket still unspent. It resolves false when
    // the URL carries no ticket, which is every other page load.
    //
    // A shared invite link (`#join=` / `#code=`) is captured even earlier: it
    // is stripped from the address bar and parked in sessionStorage, where the
    // onboarding wizard finds it after the Discord round trip.
    captureIntentFromHash();
    void handleDiscordCallback().then((handled) => {
      if (handled) return;
      // Restore the persisted session, then the last active tab on success.
      return restoreSession().then((res) => {
        if (res && res.restored) {
          resetSessionInvalidationFlag();
          if (res.role !== 'member' && !res.portal) {
            void loadAdmin().then((a) => a.restoreSavedTab());
          }
        }
        applyLinkIntentAtBoot(!!(res && res.restored));
      });
    });
  });
}
