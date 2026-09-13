/**
 * src/modules/app/auth/version-check.ts
 *
 * Sous-lot 6.3 (Strangler) — stale-tab version detection ported from app.js.
 * Polls the build-generated `/version.json` marker (cache: 'no-store') and
 * prompts a reload when it disagrees with the version actually running here.
 *
 * `app.js` still owns its own parse-time polling; this module is the typed
 * replacement and exposes `initVersionCheck()` for the final cutover. Call-time
 * `window.GM` reads keep test stubs working.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { APP_VERSION } from '../../../core/config/constants';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function esc(value: unknown): string {
  const g = winAny().GM;
  if (g && typeof g.escapeHTML === 'function') return g.escapeHTML(value);
  return value === null || value === undefined ? '' : String(value);
}

let newVersionBannerShown = false;
let versionCheckInitialized = false;

/** Currently-running version: window.GM.appVersion, else the build constant. */
export function currentAppVersion(): string {
  const w = winAny();
  return (w.GM && w.GM.appVersion) || APP_VERSION;
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
    .catch(() => { /* offline or transient network error: next check retries */ });
}

/** Bottom-right reload prompt. Idempotent (single banner at a time). */
export function showNewVersionBanner(newVersion: string): void {
  if (typeof document === 'undefined') return;
  if (newVersionBannerShown || document.getElementById('new-version-banner')) return;
  newVersionBannerShown = true;

  const banner = document.createElement('div');
  banner.id = 'new-version-banner';
  banner.style.cssText = 'position:fixed; bottom:1rem; right:1rem; z-index:9500; max-width:360px; ' +
    'background:var(--bg-soft, #1a1a24); border:1px solid rgba(99,102,241,0.4); border-radius:12px; ' +
    'padding:1rem 1.1rem; box-shadow:0 8px 24px rgba(0,0,0,0.4); display:flex; flex-direction:column; gap:.6rem;';
  banner.innerHTML =
    '<div style="display:flex; align-items:flex-start; gap:.6rem;">' +
      '<i class="ph ph-arrows-clockwise" style="font-size: var(--fs-2xl); color:var(--accent); flex-shrink:0; margin-top:.1rem;"></i>' +
      '<div>' +
        '<div style="font-weight:600; margin-bottom:.15rem;">Update available (' + esc(newVersion) + ')</div>' +
        '<div style="font-size: var(--fs-sm); color:var(--fg-dim);">This tab is running an older version. Refresh to get the latest fixes.</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex; gap:.5rem; justify-content:flex-end;">' +
      '<button type="button" id="new-version-later" class="gm-btn gm-btn-ghost gm-btn-sm">Later</button>' +
      '<button type="button" id="new-version-refresh" class="gm-btn gm-btn-primary gm-btn-sm">Refresh</button>' +
    '</div>';

  document.body.appendChild(banner);

  const later = document.getElementById('new-version-later');
  if (later) later.addEventListener('click', () => { banner.remove(); });
  const refresh = document.getElementById('new-version-refresh');
  if (refresh) refresh.addEventListener('click', () => { winAny().location.reload(); });
}

/**
 * Arms the periodic (15 min) and visibility-regain checks. Idempotent, and
 * intentionally NOT called by main.ts while app.js still runs its own copy.
 */
export function initVersionCheck(): void {
  if (versionCheckInitialized) return;
  if (typeof document === 'undefined') return;
  versionCheckInitialized = true;

  setInterval(() => { void checkForNewVersion(); }, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForNewVersion();
  });
}

/** Test hook: clears the banner/init guards. */
export function resetVersionCheck(): void {
  newVersionBannerShown = false;
  versionCheckInitialized = false;
}
