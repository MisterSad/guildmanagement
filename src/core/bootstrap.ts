/**
 * src/core/bootstrap.ts
 *
 * Startup side-effects formerly performed at parse time by gm-utils.js.
 * Called once from src/main.ts on DOMContentLoaded.
 */

import { initTermsModal } from './dom/ui';

/** Copies any legacy `rad_*` localStorage keys to `gm_*`, then removes them. */
export function migrateLegacyStorageKeys(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('rad_') === 0) keys.push(k);
    }
    for (let j = 0; j < keys.length; j++) {
      const v = localStorage.getItem(keys[j]);
      localStorage.setItem('gm_' + keys[j].substring(4), v as string);
      localStorage.removeItem(keys[j]);
    }
  } catch (e) {
    /* localStorage unavailable (no permission): ignored */
  }
}

/** Initializes window.currentGuild from the stored restriction/current guild. */
export function initCurrentGuild(): void {
  try {
    if (typeof window === 'undefined') return;
    const store = typeof localStorage !== 'undefined' ? localStorage : null;
    const localRestriction = store ? store.getItem('gm_guild_restriction') : null;
    const current = store ? store.getItem('gm_current_guild') : null;
    (window as any).currentGuild = localRestriction || current || 'ALPHA';
  } catch (_) { /* ignored */ }
}

/** Runs every gm-utils startup side-effect (idempotent enough for a single boot). */
export function runGmBootstrap(): void {
  migrateLegacyStorageKeys();
  initCurrentGuild();
  // Registers the #terms hash redirect + hashchange listener.
  initTermsModal();
}
