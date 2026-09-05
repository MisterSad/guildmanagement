import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Ticket 2.2 — Tactical Force Matrix Alignment & Timezone Collapsible UX', () => {

    describe('1. Static Template & CSS Invariants', () => {
        const html = read('index.html');
        const css = read('components.css');
        const app = read('app.js');
        const i18nJs = read('i18n.js');
        const i18nTs = read('src/core/i18n/i18n.ts');

        it('defines tabular-nums and gm-matrix-num in components.css with text-align: right and font-variant-numeric', () => {
            expect(css).toMatch(/\.tabular-nums,\s*\.gm-matrix-num\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/);
            expect(css).toMatch(/\.tabular-nums,\s*\.gm-matrix-num\s*\{[^}]*text-align:\s*right;/);
        });

        it('defines collapsible section rules in components.css including pointer cursor and caret rotation', () => {
            expect(css).toContain('.gm-collapsible-head');
            expect(css).toMatch(/\.gm-collapsible-head\s*\{[^}]*cursor:\s*pointer;/);
            expect(css).toMatch(/\.gm-collapsible-head\[aria-expanded=["']true["']\]\s*\.gm-collapse-icon\s*\{[^}]*transform:\s*rotate\(180deg\);/);
        });

        it('defines timezone_expand and timezone_collapse in both i18n.js and src/core/i18n/i18n.ts', () => {
            expect(i18nJs).toContain('timezone_expand:');
            expect(i18nJs).toContain('timezone_collapse:');
            expect(i18nTs).toContain("timezone_expand: 'Expand'");
            expect(i18nTs).toContain("timezone_collapse: 'Collapse'");
        });

        it('structures timezone coverage section as collapsible accordion closed by default in index.html', () => {
            expect(html).toContain('id="admin-timezone-section"');
            expect(html).toContain('id="admin-timezone-toggle"');
            expect(html).toContain('id="admin-timezone-body"');
            expect(html).toContain('id="admin-timezone-count"');
            expect(html).toContain('id="admin-timezone-toggle-label"');
            expect(html).toContain('id="admin-timezone-toggle-icon"');

            // Header has accessibility attributes
            expect(html).toMatch(/id="admin-timezone-toggle"[^>]*role="button"/);
            expect(html).toMatch(/id="admin-timezone-toggle"[^>]*tabindex="0"/);
            expect(html).toMatch(/id="admin-timezone-toggle"[^>]*aria-expanded="false"/);
            expect(html).toMatch(/id="admin-timezone-toggle"[^>]*aria-controls="admin-timezone-body"/);

            // Body is closed by default
            expect(html).toMatch(/id="admin-timezone-body"[^>]*style="[^"]*display:\s*none;?[^"]*"/);

            // Help button is inside header with type="button"
            expect(html).toMatch(/<button type="button" class="gm-help-btn" data-help-id="help-timezones"/);
        });

        it('applies gm-matrix-num and tabular-nums to all 8 numeric columns in app.js matrix renderer', () => {
            const numericCols = ['Power', 'Fleet', 'Tech', 'Flagship', 'Champs', 'Crew', 'Glory', 'Rally Score'];

            numericCols.forEach(col => {
                // Header check
                const thRegex = new RegExp(`<th[^>]*class="[^"]*gm-matrix-num tabular-nums[^"]*"[^>]*text-align:\\s*right[^>]*font-variant-numeric:\\s*tabular-nums[^>]*>[^<]*${col === 'Rally Score' ? '⚡ Rally Score' : col}`);
                expect(app).toMatch(thRegex);

                // Data cell check
                const tdRegex = new RegExp(`<td data-label="${col}"[^>]*class="[^"]*gm-matrix-num tabular-nums[^"]*"[^>]*text-align:\\s*right[^>]*font-variant-numeric:\\s*tabular-nums`);
                expect(app).toMatch(tdRegex);
            });

            // Rally Score chip has flex-end alignment
            expect(app).toMatch(/data-label="Rally Score"[\s\S]*?justify-content:\s*flex-end;/);
        });

        it('app.js defines initTimezoneCollapsible and exposes it on window.GM', () => {
            expect(app).toContain('function initTimezoneCollapsible()');
            expect(app).toContain('window.GM.initTimezoneCollapsible = initTimezoneCollapsible;');
        });

        it('app.js defines buildMilitaryMatrixHtml and exposes it on window.GM', () => {
            expect(app).toContain('function buildMilitaryMatrixHtml(list, sortVal, withActions, portalUids)');
            expect(app).toContain('window.GM.buildMilitaryMatrixHtml = buildMilitaryMatrixHtml;');
        });
    });

    describe('2. Tactical Force Matrix Rendered DOM Alignment', () => {
        let dom;
        let window;
        let document;
        let buildMilitaryMatrixHtml;

        function setupBuildMilitaryMatrixHtml(win, doc) {
            const appJs = read('app.js');
            const fnMatch = appJs.match(/function buildMilitaryMatrixHtml\(list, sortVal, withActions, portalUids\)[\s\S]*?\n        \}/);
            const sortMatch = appJs.match(/function sortMembers\(list, sortVal\)[\s\S]*?\n        \}/);
            const escFn = 'function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }';
            expect(fnMatch).not.toBeNull();
            expect(sortMatch).not.toBeNull();
            return new Function('window', 'document', 't', `
                ${escFn}
                var guildMembers = [];
                ${sortMatch[0]}
                ${fnMatch[0]}
                return buildMilitaryMatrixHtml;
            `)(win, doc, (k) => k);
        }

        beforeEach(() => {
            dom = new JSDOM(`<!DOCTYPE html><html><body><div id="guild-member-list"></div></body></html>`, {
                runScripts: 'dangerously',
                url: 'http://localhost'
            });
            window = dom.window;
            document = window.document;

            window.GM = window.GM || {};
            window.GM.formatPower = (p) => (Number(p) / 1e6).toFixed(1) + 'M';
            window.GM.formatNumber = (n) => String(n);
            window.GM.avatarInit = (pseudo) => (pseudo || '?').slice(0, 2).toUpperCase();
            window.GM.calculateCombatDensity = () => 1.5;
            window.GM.calculateRallyScore = (m) => (parseInt(m.fleet_rating) || 0) + (parseInt(m.tech_power) || 0);
            window.GM.calculateRallyGrade = () => 85;
            window.GM.getUidStatus = () => ({ valid: true });
            window.t = (k) => k;
            window.currentGuild = 'ALPHA';
            window.adminSelectedMembers = new Set();

            buildMilitaryMatrixHtml = setupBuildMilitaryMatrixHtml(window, document);
        });

        it('renders all 8 numeric headers and cells with text-align: right and tabular-nums', () => {
            const sampleMembers = [
                {
                    pseudo: 'VanguardOne',
                    uid: '10001',
                    guild: 'ALPHA',
                    role: 'R4',
                    overall_power: 125000000,
                    fleet_rating: 45000000,
                    tech_power: 32000000,
                    flagship_power: 28000000,
                    champion_power: 15000000,
                    crew_power: 5000000,
                    glory_score: 950000
                },
                {
                    pseudo: 'StarlightAce',
                    uid: '10002',
                    guild: 'ALPHA',
                    role: 'R3',
                    overall_power: 98000000,
                    fleet_rating: 38000000,
                    tech_power: 25000000,
                    flagship_power: 21000000,
                    champion_power: 11000000,
                    crew_power: 3000000,
                    glory_score: 820000
                }
            ];

            const html = buildMilitaryMatrixHtml(sampleMembers, 'rally_desc', true, {});
            document.getElementById('guild-member-list').innerHTML = html;

            const table = document.querySelector('.gm-table');
            expect(table).not.toBeNull();

            // Verify Headers
            const headers = Array.from(table.querySelectorAll('thead th'));
            const numericHeaderNames = ['Power', '⚔️ Fleet', '🔬 Tech', '🚀 Flagship', '👑 Champs', '👥 Crew', '🏆 Glory', '⚡ Rally Score'];

            headers.forEach(th => {
                const text = th.textContent.trim();
                const isNumeric = numericHeaderNames.some(name => text.includes(name.replace(/^[^\w\s]+\s*/, '')));
                if (isNumeric) {
                    expect(th.classList.contains('gm-matrix-num')).toBe(true);
                    expect(th.classList.contains('tabular-nums')).toBe(true);
                    expect(th.style.textAlign).toBe('right');
                    expect(th.style.fontVariantNumeric).toBe('tabular-nums');
                } else if (text.includes('Player')) {
                    expect(th.style.textAlign).toBe('left');
                } else {
                    expect(th.style.textAlign).toBe('center');
                }
            });

            // Verify Data Rows
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            expect(rows.length).toBe(2);

            const numericLabels = ['Power', 'Fleet', 'Tech', 'Flagship', 'Champs', 'Crew', 'Glory', 'Rally Score'];

            rows.forEach(row => {
                numericLabels.forEach(label => {
                    const td = row.querySelector(`td[data-label="${label}"]`);
                    expect(td, `Cell ${label} should exist`).not.toBeNull();
                    expect(td.classList.contains('gm-matrix-num')).toBe(true);
                    expect(td.classList.contains('tabular-nums')).toBe(true);
                    expect(td.style.textAlign).toBe('right');
                    expect(td.style.fontVariantNumeric).toBe('tabular-nums');

                    if (label === 'Rally Score') {
                        const chip = td.querySelector('.gm-chip');
                        if (chip) {
                            expect(chip.style.display).toBe('inline-flex');
                            expect(chip.style.justifyContent).toBe('flex-end');
                            expect(chip.style.fontVariantNumeric).toBe('tabular-nums');
                        }
                    }
                });

                // Check non-numeric cells are not right aligned
                const rallyTd = row.querySelector('td[data-label="Rally"]');
                const roleTd = row.querySelector('td[data-label="Role"]');
                const actionTd = row.querySelector('td[data-label="Action"]');
                expect(rallyTd.style.textAlign).toBe('center');
                expect(roleTd.style.textAlign).toBe('center');
                expect(actionTd.style.textAlign).toBe('center');
            });
        });
    });

    describe('3. Timezone Coverage Collapsible Interaction & Accessibility', () => {
        let dom;
        let window;
        let document;
        let initTimezoneCollapsible;

        function setupInitTimezoneCollapsible(win, doc) {
            const appJs = read('app.js');
            const fnMatch = appJs.match(/function initTimezoneCollapsible\(\)[\s\S]*?\n    \}/);
            expect(fnMatch).not.toBeNull();
            return new Function('document', 'window', 't', `
                ${fnMatch[0]}
                return initTimezoneCollapsible;
            `)(doc, win, win.t);
        }

        beforeEach(() => {
            const rawHtml = read('index.html');
            // Extract the timezone section snippet from index.html for accurate DOM testing
            const match = rawHtml.match(/<div class="gm-section gm-collapsible-section" id="admin-timezone-section"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
            const timezoneSnippet = match ? match[0] : `
                <div class="gm-section gm-collapsible-section" id="admin-timezone-section" style="display: none;">
                    <div class="gm-section-head gm-collapsible-head" id="admin-timezone-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="admin-timezone-body">
                        <div class="gm-section-title">
                            <i class="ph ph-clock"></i>
                            <span>Timezone Coverage</span> <button type="button" class="gm-help-btn" data-help-id="help-timezones" aria-label="Help: Timezones"><i class="ph ph-info"></i></button>
                            <span class="gm-count" id="admin-timezone-count">0</span>
                        </div>
                        <div class="gm-collapsible-indicator">
                            <span id="admin-timezone-toggle-label" data-i18n="timezone_expand">Expand</span>
                            <i class="ph ph-caret-down gm-collapse-icon" id="admin-timezone-toggle-icon"></i>
                        </div>
                    </div>
                    <div id="admin-timezone-body" class="gm-collapsible-body" style="display: none;">
                        <div class="gm-section-sub">Local hour</div>
                        <div id="admin-timezone-list"></div>
                    </div>
                </div>`;

            dom = new JSDOM(`<!DOCTYPE html><html><body>${timezoneSnippet}</body></html>`, {
                runScripts: 'dangerously',
                url: 'http://localhost'
            });
            window = dom.window;
            document = window.document;

            window.t = (k) => (k === 'timezone_collapse' ? 'Collapse' : (k === 'timezone_expand' ? 'Expand' : k));
            initTimezoneCollapsible = setupInitTimezoneCollapsible(window, document);
            initTimezoneCollapsible();
        });

        it('initializes in collapsed state: aria-expanded="false", body hidden, and label "Expand"', () => {
            const toggle = document.getElementById('admin-timezone-toggle');
            const body = document.getElementById('admin-timezone-body');
            const label = document.getElementById('admin-timezone-toggle-label');

            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(body.style.display).toBe('none');
            expect(label.textContent.trim()).toBe('Expand');
        });

        it('expands on click and collapses on subsequent click, updating aria-expanded, body style, and label', () => {
            const toggle = document.getElementById('admin-timezone-toggle');
            const body = document.getElementById('admin-timezone-body');
            const label = document.getElementById('admin-timezone-toggle-label');

            // 1. First Click: Open accordion
            toggle.click();
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            expect(body.style.display).toBe('block');
            expect(label.textContent.trim()).toBe('Collapse');
            expect(label.getAttribute('data-i18n')).toBe('timezone_collapse');

            // 2. Second Click: Close accordion
            toggle.click();
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(body.style.display).toBe('none');
            expect(label.textContent.trim()).toBe('Expand');
            expect(label.getAttribute('data-i18n')).toBe('timezone_expand');
        });

        it('supports keyboard navigation via Enter and Space keys', () => {
            const toggle = document.getElementById('admin-timezone-toggle');
            const body = document.getElementById('admin-timezone-body');
            const label = document.getElementById('admin-timezone-toggle-label');

            // Enter key expands
            const enterEvt = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
            toggle.dispatchEvent(enterEvt);
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            expect(body.style.display).toBe('block');
            expect(label.textContent.trim()).toBe('Collapse');

            // Space key collapses
            const spaceEvt = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true });
            toggle.dispatchEvent(spaceEvt);
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(body.style.display).toBe('none');
            expect(label.textContent.trim()).toBe('Expand');
        });

        it('isolates help button clicks from toggling the accordion', () => {
            const toggle = document.getElementById('admin-timezone-toggle');
            const body = document.getElementById('admin-timezone-body');
            const helpBtn = document.querySelector('.gm-help-btn');

            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(body.style.display).toBe('none');

            // Click the help button inside the header
            helpBtn.click();

            // Should remain collapsed
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(body.style.display).toBe('none');
        });
    });
});
