// Medium-term plan, M4c step 1 (audit ARC-07, FE-07): the feature modules no
// longer read what the app installed on `window` -- window.GM, the GM_*
// namespaces, window.showConfirm, the cross-cutting state mirrored there.
// They import the typed function instead. main.ts still installs the bridge
// (the e2e suite drives the app through it) until step 2 removes it.
//
// Browser APIs reached through `window` (location, matchMedia, events...) are
// not the bridge and are not matched here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MODULES = path.resolve(__dirname, '../src/modules');
const BRIDGE = /\(window as any\)|winAny\(|window\.GM\b|\bGM_[A-Z_]+\.|window\.showConfirm|\.showConfirm\s*\(/;

// Each allowed line is named, with why it is still here.
const ALLOWED = [
  // auth.controller publishes the signed-in account id for core/auth/roles'
  // currentAccountId() fallback; it moves to app-state in M4c step 2.
  "  const bridge = typeof window !== 'undefined' ? (window as any).GM : null;",
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : (e.name.endsWith('.ts') ? [p] : []);
  });
}

describe('feature modules do not read the window bridge', () => {
  it('no module reads window.GM, a GM_* namespace or window.showConfirm', () => {
    const offenders = [];
    for (const f of files(MODULES)) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        // The imported showConfirm is called bare; only `x.showConfirm(` is a window member.
        if (!BRIDGE.test(line) || ALLOWED.includes(line)) return;
        offenders.push(`${path.relative(MODULES, f)}:${i + 1}: ${trimmed}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
