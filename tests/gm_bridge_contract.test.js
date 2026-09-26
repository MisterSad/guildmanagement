// Phase 7, step 1 — the safety net, before any of the bridge is dismantled.
//
// FINDING M8. `main.ts` installs ~15 `GM_*` namespaces on `window`, and views
// call each other through them. Nothing type-checks that contract: renaming
// `GM_MEMBERS.fetchGuildMembers` leaves `tsc --noEmit` green while the Members
// tab silently stops loading, because every consumer resolves the method by
// string at call time and no-ops when it is absent.
//
// This file is that missing check. It reads what `main.ts` PROVIDES and what the
// rest of `src/` CALLS, and fails when the two disagree. It must keep passing
// for as long as any part of the bridge survives, and it is what makes the
// conversion to typed imports safe to do incrementally.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const mainSrc = stripComments(read('src/main.ts'));

/**
 * Methods each namespace provides, read from the object literal `main.ts`
 * assigns. Handles both shapes in use: shorthand (`fetchAccounts,`) and an
 * arrow wrapper (`load: () => gloryView.load()`).
 */
function providedByNamespace() {
  const provided = {};
  const re = /(?:wAny|\(window as any\))\.(GM_[A-Z_]+)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(mainSrc)) !== null) {
    const ns = m[1];
    // Walk braces from the opening one so nested objects/arrows do not end it early.
    let depth = 0;
    let i = mainSrc.indexOf('{', m.index);
    const start = i;
    for (; i < mainSrc.length; i += 1) {
      if (mainSrc[i] === '{') depth += 1;
      else if (mainSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = mainSrc.slice(start + 1, i);
    const names = new Set(provided[ns] || []);
    for (const k of body.matchAll(/(?:^|[\s,{])([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) names.add(k[1]);
    // The trailing entry of a literal has no comma after it, so the lookahead
    // must accept end-of-body too -- otherwise the last method of every
    // namespace reads as missing.
    for (const k of body.matchAll(/(?:^|[\s,{])([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=,|$)/gm)) names.add(k[1]);
    provided[ns] = [...names];
  }
  // Namespaces built by assigning properties one at a time rather than as a literal.
  for (const k of mainSrc.matchAll(/(?:wAny|\(window as any\))\.(GM_[A-Z_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g)) {
    provided[k[1]] = [...new Set([...(provided[k[1]] || []), k[2]])];
  }
  return provided;
}

/** Every `GM_NS.method` the rest of src/ calls, with where it calls it. */
function calledByNamespace() {
  const called = {};
  for (const f of walk('src')) {
    if (f === 'src/main.ts') continue;
    const src = stripComments(read(f));
    for (const m of src.matchAll(/\bGM_([A-Z_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      const ns = `GM_${m[1]}`;
      called[ns] = called[ns] || {};
      called[ns][m[2]] = called[ns][m[2]] || new Set();
      called[ns][m[2]].add(f);
    }
  }
  return called;
}

/** Namespace/method pairs the router resolves by string rather than by import. */
function routerStringCalls() {
  const router = stripComments(read('src/modules/app/router.ts'));
  return [...router.matchAll(/invokeMethod\(\s*'(GM_[A-Z_]+)'\s*,\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)]
    .map((m) => `${m[1]}.${m[2]}`);
}

const provided = providedByNamespace();
const called = calledByNamespace();

describe('M8 — the window bridge has a contract that is actually checked', () => {
  it('finds the namespaces main.ts installs', () => {
    // Guards the guard: a parser that silently matched nothing would make every
    // assertion below vacuous and permanently green.
    const names = Object.keys(provided);
    expect(names.length, `namespaces parsed: ${names.join(', ')}`).toBeGreaterThanOrEqual(12);
    expect(names).toContain('GM_MEMBERS');
    expect(names).toContain('GM_ADMIN');
    expect(provided.GM_MEMBERS).toContain('fetchGuildMembers');
  });

  it('provides every method the rest of src/ calls on a namespace', () => {
    const missing = [];
    for (const [ns, methods] of Object.entries(called)) {
      for (const [method, files] of Object.entries(methods)) {
        if (!provided[ns] || !provided[ns].includes(method)) {
          missing.push(`${ns}.${method}  (called from ${[...files].join(', ')})`);
        }
      }
    }
    expect(missing, `called but never installed:\n${missing.join('\n')}`).toEqual([]);
  });

  it('provides every method the router resolves by string', () => {
    // The router's own calls become compile-checked as they convert to typed
    // imports; until then this is the only thing standing between a rename and
    // a tab that silently stops loading.
    const missing = routerStringCalls().filter((pair) => {
      const [ns, method] = pair.split('.');
      return !provided[ns] || !provided[ns].includes(method);
    });
    expect(missing, `router calls nothing provides: ${missing.join(', ')}`).toEqual([]);
  });

  it('records how much of the router still goes through strings', () => {
    // Phase 7 drives this to zero. It is asserted rather than described so the
    // number cannot quietly go back up.
    const remaining = routerStringCalls();
    expect(remaining.length, `still string-resolved: ${remaining.join(', ')}`).toBe(0);
  });
});

describe('M8 — namespaces phase 7 has already disconnected', () => {
  // Each of these had consumers reaching for it through `window`. They are
  // ordinary imports now, so the namespace may still be INSTALLED by main.ts
  // for whatever else reads it, but nothing in src/ resolves it by string any
  // more. Asserting the absence is what stops one creeping back.
  const disconnected = [
    'GM_EVENTS',
    'GM_ARMSRACE',
    'GM_SHADOWFRONT',
    'GM_OCR',
    'GM_SHELL',
    'GM_MEMBERS',
    'GM_ADMIN',
    'GM_STATS',
    'GM_GLORY',
    'GM_HISTORY',
    'GM_TICKETS',
    'GM_SANCTIONS',
    'GM_MIGRATION_HUB',
    'GM_PORTAL',
    'GM_OVERVIEW'
  ];

  for (const ns of disconnected) {
    it(`${ns} has no string-resolved consumer left`, () => {
      const offenders = [];
      for (const f of walk('src')) {
        if (f === 'src/main.ts' || f === 'src/core/gm-bridge.ts') continue;
        const code = stripComments(read(f))
          // `'[GM_STATS] …'` and friends are log prefixes, not bridge access.
          .replace(/'\[GM_[A-Z_]+\]/g, "'");
        if (new RegExp(`\\b${ns}\\b`).test(code)) offenders.push(f);
      }
      expect(offenders, `${ns} still reached via window in: ${offenders.join(', ')}`).toEqual([]);
    });
  }

  it('records the namespaces still resolved by string, and why', () => {
    // These three are DELIBERATE and are not phase-7 work:
    //   GM_APP / GM_I  — `core/` must not import `modules/`. `core/dom/toast.ts`
    //     is the very implementation `GM_APP.showToast` points at, so importing
    //     the app's renderer here would invert the layering (and recurse).
    //   GM_COLLAPSED_ROLES — a mirrored state global, not a method bridge; it
    //     belongs to the `window`-mirror collapse (finding M7, phase 3).
    const remaining = new Set();
    for (const f of walk('src')) {
      if (f === 'src/main.ts' || f === 'src/core/gm-bridge.ts') continue;
      const code = stripComments(read(f)).replace(/'\[GM_[A-Z_]+\]/g, "'");
      for (const m of code.matchAll(/\bGM_[A-Z_]+/g)) remaining.add(m[0]);
    }
    expect([...remaining].sort()).toEqual([
      'GM_APP',
      'GM_BADGES',
      'GM_COLLAPSED_ROLES',
      'GM_GVG_TASKS',
      'GM_I'
    ]);
  });
});
