// Strangler cutover: the legacy root i18n.js and gm-utils.js are gone, so
// replicate the src/main.ts bridges for the test environment.
import { t as i18nT, getLang as i18nGetLang, setLang as i18nSetLang, applyTranslations as i18nApplyTranslations } from '../src/core/i18n/i18n';
import { installGmBridge } from '../src/core/gm-bridge';

if (typeof window !== 'undefined') {
    window.GM_I18N = { t: i18nT, getLang: i18nGetLang, setLang: i18nSetLang, applyTranslations: i18nApplyTranslations };
    window.GM = window.GM || {};
    window.GM.t = i18nT;
    // Full legacy window.GM surface from the typed /src modules.
    installGmBridge();
    if (!window.currentGuild) window.currentGuild = 'ALPHA';
}

// Node 26 ships an experimental global `localStorage` (gated behind
// --localstorage-file), which makes vitest's jsdom environment skip the real
// jsdom Storage when populating globals. Install a memory-backed Storage
// implementation so app code can read/write it exactly like in a browser.
function createMemoryStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(String(k)); },
        clear: () => { store.clear(); },
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; }
    };
}

for (const name of ['localStorage', 'sessionStorage']) {
    if (typeof globalThis[name] === 'undefined' || name === 'localStorage') {
        Object.defineProperty(globalThis, name, {
            value: createMemoryStorage(),
            configurable: true,
            writable: true
        });
    }
}
