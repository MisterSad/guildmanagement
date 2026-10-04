// The app installs nothing on `window` since M4c (only the frozen GM_E2E,
// which main.ts sets and no unit test needs). Tests install a fake client with
// setDbClient() and seed state with patchAppState(), exactly as the app does.
import { beforeEach } from 'vitest';
import { setVerifiedRole } from '../src/core/auth/roles';
import { patchAppState } from '../src/core/state/app-state';

// The default tenant every test file starts on, as the bridge used to seed it.
patchAppState({ currentGuild: 'ALPHA' });

beforeEach(() => {
  setVerifiedRole(null, null);
});

// Node 26 ships an experimental global `localStorage` (gated behind
// --localstorage-file), which makes vitest's jsdom environment skip the real
// jsdom Storage when populating globals. Install a memory-backed Storage
// implementation so app code can read/write it exactly like in a browser.
function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => {
      store.set(String(k), String(v));
    },
    removeItem: (k) => {
      store.delete(String(k));
    },
    clear: () => {
      store.clear();
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

for (const name of ['localStorage', 'sessionStorage']) {
  if (typeof globalThis[name] === 'undefined' || name === 'localStorage') {
    Object.defineProperty(globalThis, name, {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
