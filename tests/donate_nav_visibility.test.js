// Regression guard: a real guild's server_admin reported the "Buy Me a
// Coffee" nav link was completely missing for them. Root cause was
// visibleNavItems() allowlisting only super_admin/guild_admin for any
// `adminOnly` NAV_ITEMS entry -- server_admin (a real, legitimate admin
// role) silently fell through the cracks. Fixed to exclude by role
// (member only) instead of allowlisting roles, so a future admin sub-role
// can't hit the exact same gap again.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Donate nav item ("Buy Me a Coffee") visibility', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');

    it('the subscription/donate NAV_ITEMS entry is still adminOnly (never shown to a member)', () => {
        const navStart = shell.indexOf('const NAV_ITEMS: ShellNavItem[] = [');
        const navEnd = shell.indexOf('];', navStart);
        const nav = shell.slice(navStart, navEnd);
        const donateLine = nav.split('\n').find((l) => l.includes("id: 'subscription'"));
        expect(donateLine, 'subscription NAV_ITEMS entry must exist').toBeTruthy();
        expect(donateLine).toContain('adminOnly: true');
    });

    it('never re-introduces the role-allowlist that excluded server_admin', () => {
        // The exact old (broken) allowlist pattern must never come back.
        expect(shell).not.toMatch(/adminOnly\s*&&\s*role\s*!==\s*['"]super_admin['"]\s*&&\s*role\s*!==\s*['"]guild_admin['"]/);
    });

    it('visibleNavItems only excludes adminOnly items for a member, not by allowlisting specific admin roles', () => {
        const fnStart = shell.indexOf('visibleNavItems(): ShellNavItem[]');
        const fnEnd = shell.indexOf('\n  }', fnStart);
        const fn = shell.slice(fnStart, fnEnd);
        expect(fn).toMatch(/if\s*\(i\.adminOnly\s*&&\s*role\s*===\s*['"]member['"]\)\s*return;/);
    });
});

describe('Donate nav item styling (coffee-brown accent) is wired everywhere the link renders', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    const shellCss = read('shell.css');
    const portalJs = read('portal.js');

    it('shell.css defines the coffee-brown accent class', () => {
        expect(shellCss).toContain('.gm-donate-nav-item');
        expect(shellCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    });

    it('the sidebar footer button, the mobile drawer, and the Player Portal nav all apply the class to the donation item specifically', () => {
        // shell.js: sidebar footer + drawer
        const donateClsOccurrences = (shell.match(/gm-donate-nav-item/g) || []).length;
        expect(donateClsOccurrences).toBeGreaterThanOrEqual(2);
        // portal.js: primary nav render + mobile "More" drawer render
        const portalOccurrences = (portalJs.match(/gm-donate-nav-item/g) || []).length;
        expect(portalOccurrences).toBeGreaterThanOrEqual(1);
    });
});
