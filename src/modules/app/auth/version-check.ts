/**
 * src/modules/app/auth/version-check.ts
 *
 * Sous-lot 6.3 (Strangler) — stale-tab version detection ported from app.js.
 * Polls the build-generated `/version.json` marker (cache: 'no-store') and
 * prompts a reload when it disagrees with the version actually running here.
 *
 * The running version is the build constant, imported (phase M4c) rather than
 * read back from the bridge that main.ts publishes it on.
 */

import { APP_VERSION } from '../../../core/config/constants';
import { escapeHTML } from '../../../core/utils/text';

function esc(value: unknown): string {
  return escapeHTML(value);
}

let newVersionBannerShown = false;
let versionCheckInitialized = false;

/** Currently-running version: the build constant baked into this bundle. */
export function currentAppVersion(): string {
  return APP_VERSION;
}

/** Fetches /version.json (network-fresh) and prompts if it disagrees. */
export function checkForNewVersion(): Promise<void> {
  if (!currentAppVersion() || newVersionBannerShown) return Promise.resolve();
  if (typeof fetch !== 'function') return Promise.resolve();

  return fetch('/version.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: any) => {
      if (data && data.version && data.version !== currentAppVersion()) {
        showNewVersionBanner(data.version);
      }
    })
    .catch(() => {
      /* offline or transient network error: next check retries */
    });
}

/** Bottom-right reload prompt. Idempotent (single banner at a time). */
export function showNewVersionBanner(newVersion: string): void {
  if (typeof document === 'undefined') return;
  if (newVersionBannerShown || document.getElementById('new-version-banner')) return;
  newVersionBannerShown = true;

  const banner = document.createElement('div');
  banner.id = 'new-version-banner';
  banner.style.cssText =
    'position:fixed; bottom:1rem; right:1rem; z-index:9500; max-width:360px; ' +
    'background:var(--bg-soft, #1a1a24); border:1px solid rgba(99,102,241,0.4); border-radius:12px; ' +
    'padding:1rem 1.1rem; box-shadow:0 8px 24px rgba(0,0,0,0.4); display:flex; flex-direction:column; gap:.6rem;';
  banner.innerHTML =
    '<div class="u-d-flex u-items-flex-start u-gap-0_6rem">' +
    '<i class="u-fs-fs-2xl u-c-accent u-shrink-0 u-mt-0_1rem ph ph-arrows-clockwise"></i>' +
    '<div>' +
    '<div class="u-fw-600 u-mb-0_15rem">Update available (' +
    esc(newVersion) +
    ')</div>' +
    '<div class="u-fs-fs-sm u-c-fg-dim">This tab is running an older version. Refresh to get the latest fixes.</div>' +
    '</div>' +
    '</div>' +
    '<div class="u-d-flex u-gap-0_5rem u-justify-flex-end">' +
    '<button type="button" id="new-version-later" class="gm-btn gm-btn-ghost gm-btn-sm">Later</button>' +
    '<button type="button" id="new-version-refresh" class="gm-btn gm-btn-primary gm-btn-sm">Refresh</button>' +
    '</div>';

  document.body.appendChild(banner);

  const later = document.getElementById('new-version-later');
  if (later) {
    later.addEventListener('click', () => {
      banner.remove();
      // Re-arm the prompt. Without this reset `newVersionBannerShown` stayed
      // true for the lifetime of the tab, so `checkForNewVersion()` short-
      // circuited on its first line and a user who dismissed the banner once
      // was never offered the update again -- on a long-lived tab that means
      // running stale code indefinitely, which is exactly what this mechanism
      // exists to prevent. The 15-minute poll will surface it again.
      newVersionBannerShown = false;
    });
  }
  const refresh = document.getElementById('new-version-refresh');
  if (refresh)
    refresh.addEventListener('click', () => {
      window.location.reload();
    });
}

/**
 * Arms the periodic (15 min) and visibility-regain checks. Idempotent, and
 * intentionally NOT called by main.ts while app.js still runs its own copy.
 */
export function initVersionCheck(): void {
  if (versionCheckInitialized) return;
  if (typeof document === 'undefined') return;
  versionCheckInitialized = true;

  setInterval(
    () => {
      void checkForNewVersion();
    },
    15 * 60 * 1000
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForNewVersion();
  });
}

/** Test hook: clears the banner/init guards. */
export function resetVersionCheck(): void {
  newVersionBannerShown = false;
  versionCheckInitialized = false;
}
