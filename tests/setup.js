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
