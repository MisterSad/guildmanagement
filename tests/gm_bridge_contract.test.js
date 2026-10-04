// The window bridge: from an unchecked contract (finding M8) to its end state (M4c).
//
// FINDING M8. `main.ts` used to install ~15 `GM_*` namespaces on `window` (plus
// `window.GM` itself), and views called each other through them. Nothing
// type-checked that contract: renaming `GM_MEMBERS.fetchGuildMembers` left
// `tsc --noEmit` green while the Members tab silently stopped loading, because
// every consumer resolved the method by string at call time and no-oped when
// it was absent. Phase 7 started with this file reading what `main.ts`
// PROVIDED and what the rest of `src/` CALLED, and failing when they disagreed;
// that is what made converting the bridge to typed imports safe to do
// incrementally.
//
// M4c END STATE. The conversion is finished. `src/core/gm-bridge.ts` is
// deleted, `window.GM`, `GM_I18N`, `GM_APP`, every other `GM_*` namespace,
// `window.showConfirm` and the state mirror (`window.currentGuild`,
// `guildsList`, `GM_COLLAPSED_ROLES`...) are gone. Modules import each other,
// so the compiler checks the contract M8 was about. Exactly one global
// survives, deliberately: `GM_E2E`, a frozen, non-writable object that lets
// the Playwright suite drive a few entry points of the real bundle. This file
// now pins that end state so no global creeps back.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

const srcFiles = walk('src', ['.ts']);
const mainSrc = stripComments(read('src/main.ts'));

/** Returns the text between the brace at `open` and its matching close. */
function braceBody(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces');
}

/** Top-level keys of an object-literal body (shorthand, `key:` or `key()`). */
function topLevelKeys(body) {
  const entries = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      entries.push(cur);
      cur = '';
    } else cur += ch;
  }
  entries.push(cur);
  return entries
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const m = e.match(/^([A-Za-z_$][\w$]*)\s*(?::|\(|$)/);
      return m ? m[1] : `<unparsed: ${e.slice(0, 40)}>`;
    });
}

/**
 * Identifiers a file binds to `window` (`const w = window as any`,
 * `const w = (typeof window !== 'undefined' ? window : {}) as any`), so an
 * alias cannot launder a global the checks below forbid.
 */
function windowAliases(code) {
  const names = [];
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]*)/g)) {
    const rhs = m[2];
    if (/^\(?\s*window\b(?!\.)/.test(rhs) || /\?\s*window\s*:/.test(rhs)) names.push(m[1]);
  }
  return names;
}

/** `window`, `(window as any)`, `(window as unknown as X)` or a local alias. */
function receiverPattern(aliases) {
  const alts = ['\\bwindow', '\\(\\s*window\\s+as\\s+[^)]*\\)', ...aliases.map((a) => `\\b${a}`)];
  return `(?:${alts.join('|')})`;
}

// `'[GM_STATS] ...'` and friends are log prefixes, not globals.
const dropLogPrefixes = (code) => code.replace(/(['"`])\[GM_[A-Z_]+\]/g, '$1');

const E2E_KEYS = ['showAdminDashboard', 'openOcrModal', 'loadPortalDashboard', 'openDialog', 'showConfirm'];

describe('M4c — the bridge module is gone', () => {
  it('src/core/gm-bridge.ts does not exist', () => {
    expect(fs.existsSync(path.join(rootDir, 'src/core/gm-bridge.ts'))).toBe(false);
  });

  it('nothing in src/ imports a gm-bridge module', () => {
    const offenders = srcFiles.filter((f) => /from\s+['"][^'"]*gm-bridge['"]/.test(stripComments(read(f))));
    expect(offenders).toEqual([]);
  });
});

describe('M4c — main.ts installs exactly one global, GM_E2E', () => {
  const defineAt = mainSrc.search(/Object\.defineProperty\(\s*window\s*,\s*'GM_E2E'\s*,\s*\{/);

  it('defines GM_E2E with Object.defineProperty', () => {
    expect(defineAt, "Object.defineProperty(window, 'GM_E2E', {...}) not found in main.ts").toBeGreaterThanOrEqual(0);
  });

  it('freezes the value and makes the property non-writable and non-configurable', () => {
    const descriptor = braceBody(mainSrc, mainSrc.indexOf('{', defineAt));
    expect(descriptor).toMatch(/^\s*value\s*:\s*Object\.freeze\(\s*\{/);
    expect(descriptor).toMatch(/\bwritable\s*:\s*false\b/);
    expect(descriptor).toMatch(/\bconfigurable\s*:\s*false\b/);
    expect(descriptor).not.toMatch(/\bwritable\s*:\s*true\b/);
  });

  it('exposes exactly the five e2e entry points', () => {
    const descriptor = braceBody(mainSrc, mainSrc.indexOf('{', defineAt));
    const freezeAt = descriptor.search(/Object\.freeze\(\s*\{/);
    const keys = topLevelKeys(braceBody(descriptor, descriptor.indexOf('{', freezeAt)));
    // Guards the guard: a parser that matched nothing would pass a subset check.
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual([...E2E_KEYS].sort());
  });

  it('is the only Object.defineProperty / Object.assign onto window in src/', () => {
    const hits = [];
    for (const f of srcFiles) {
      const code = stripComments(read(f));
      const aliases = windowAliases(code);
      const re = new RegExp(
        `Object\\.(?:defineProperty|defineProperties|assign)\\(\\s*${receiverPattern(aliases)}\\s*,\\s*([^,]*)`,
        'g'
      );
      for (const m of code.matchAll(re)) hits.push(`${f}: ${m[1].trim()}`);
    }
    expect(hits).toEqual(["src/main.ts: 'GM_E2E'"]);
  });
});

describe('M4c — no other global is installed or read anywhere in src/', () => {
  it('no file assigns a property on window (navigation excepted)', () => {
    // `window.location.href = ...` navigates; it does not create a global.
    const offenders = [];
    for (const f of srcFiles) {
      const code = stripComments(read(f));
      const re = new RegExp(
        `${receiverPattern(windowAliases(code))}\\.((?:[A-Za-z_$][\\w$]*)(?:\\.[A-Za-z_$][\\w$]*)*)\\s*(?:=(?!=)|\\+=|\\|\\|=|\\?\\?=)`,
        'g'
      );
      for (const m of code.matchAll(re)) {
        if (/^location(\.|$)/.test(m[1])) continue;
        offenders.push(`${f}: window.${m[1]} =`);
      }
    }
    expect(offenders, `globals assigned:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no file reaches for window.GM or any GM_* name (GM_E2E in main.ts excepted)', () => {
    const offenders = [];
    for (const f of srcFiles) {
      let code = dropLogPrefixes(stripComments(read(f)));
      if (f === 'src/main.ts') code = code.replace(/'GM_E2E'/, "''");
      const recv = receiverPattern(windowAliases(code));
      for (const m of code.matchAll(new RegExp(`${recv}\\.GM\\b`, 'g'))) offenders.push(`${f}: ${m[0]}`);
      for (const m of code.matchAll(/\bGM_[A-Z][A-Z0-9_]*/g)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders, `bridge access left:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no file reads the retired window state mirror or window.showConfirm', () => {
    // The state lives in core/state/app-state.ts (getAppState / patchAppState);
    // a read off `window` now silently sees `undefined`.
    const retired = [
      'currentGuild',
      'currentGuildRestriction',
      'currentServerRestriction',
      'guildsList',
      'guildsData',
      'showConfirm',
    ];
    const offenders = [];
    for (const f of srcFiles) {
      const code = stripComments(read(f));
      const re = new RegExp(`${receiverPattern(windowAliases(code))}\\.(${retired.join('|')})\\b`, 'g');
      for (const m of code.matchAll(re)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders, `retired globals still read:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('M4c — the e2e suite drives the app only through GM_E2E', () => {
  it('no e2e spec uses window.GM, GM_APP, GM_OCR, GM_PORTAL or window.showConfirm', () => {
    const specs = walk('e2e', ['.js', '.ts', '.mjs']);
    expect(specs.length).toBeGreaterThan(0);
    const offenders = [];
    for (const f of specs) {
      const code = stripComments(read(f));
      const recv = receiverPattern(windowAliases(code));
      const patterns = [
        new RegExp(`${recv}\\.GM\\b`, 'g'),
        new RegExp(`${recv}\\.showConfirm\\b`, 'g'),
        /\bGM_(?:APP|OCR|PORTAL)\b/g,
      ];
      for (const re of patterns) for (const m of code.matchAll(re)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders, `legacy bridge use in e2e:\n${offenders.join('\n')}`).toEqual([]);
  });
});
