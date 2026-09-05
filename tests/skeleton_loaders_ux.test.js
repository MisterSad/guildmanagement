import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { SubscriptionView } from '../src/modules/subscription/subscription-view.ts';
import { CrossRankView } from '../src/modules/matchup/cross-rank.ts';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Ticket 3.1 — Skeleton Loaders UX Enhancement', () => {

    describe('1. Global CSS Styles (components.css)', () => {
        const css = read('components.css');

        it('defines skeleton animations: gm-skeleton-pulse and gm-skeleton-shimmer', () => {
            expect(css).toContain('@keyframes gm-skeleton-pulse');
            expect(css).toContain('@keyframes gm-skeleton-shimmer');
        });

        it('defines base .gm-skeleton class with shimmer gradient, border-radius, and animations', () => {
            expect(css).toMatch(/\.gm-skeleton\s*\{[^}]*animation:[^}]*gm-skeleton-shimmer/);
            expect(css).toMatch(/\.gm-skeleton\s*\{[^}]*animation:[^}]*gm-skeleton-pulse/);
            expect(css).toMatch(/\.gm-skeleton\s*\{[^}]*border-radius:/);
            expect(css).toMatch(/\.gm-skeleton\s*\{[^}]*user-select:\s*none;/);
        });

        it('defines skeleton utility classes for text, title, badge, avatar, btn, and card', () => {
            expect(css).toContain('.gm-skeleton-text');
            expect(css).toContain('.gm-skeleton-title');
            expect(css).toContain('.gm-skeleton-badge');
            expect(css).toContain('.gm-skeleton-avatar');
            expect(css).toContain('.gm-skeleton-btn');
            expect(css).toContain('.gm-skeleton-card');
        });
    });

    describe('2. Bug Tickets Skeleton Loader (tickets.js)', () => {
        const ticketsCode = read('tickets.js');

        function setupTicketsLoadingHtml(doc, win) {
            const fnMatch = ticketsCode.match(/function loadingHtml\(\)[\s\S]*?\n    \}/);
            expect(fnMatch).not.toBeNull();
            return new Function('document', 'window', `
                ${fnMatch[0]}
                return loadingHtml;
            `)(doc, win);
        }

        it('replaces raw "Loading tickets..." text and lonely spinner with card silhouettes', () => {
            expect(ticketsCode).not.toContain('<div class="gm-empty-title">Loading tickets...</div>');

            const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="tickets-container"></div></body></html>`);
            const getLoadingHtml = setupTicketsLoadingHtml(dom.window.document, dom.window);
            const html = getLoadingHtml();

            // Skeletons are present
            expect(html).toContain('gm-tickets-skeleton-list');
            expect(html).toContain('aria-busy="true"');
            expect(html).toContain('gm-skeleton-card');
            expect(html).toContain('gm-skeleton-badge');
            expect(html).toContain('gm-skeleton-title');
            expect(html).toContain('gm-skeleton-btn');

            // No raw loading text
            expect(html).not.toContain('Loading tickets...');
            expect(html).not.toContain('ph-circle-notch');

            // Inserts 4 card silhouettes
            const container = dom.window.document.getElementById('tickets-container');
            container.innerHTML = html;
            const cards = container.querySelectorAll('.gm-skeleton-card');
            expect(cards.length).toBe(4);
        });

        it('replaces skeleton cleanly when real tickets render', () => {
            const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="tickets-container"></div></body></html>`);
            const container = dom.window.document.getElementById('tickets-container');

            const getLoadingHtml = setupTicketsLoadingHtml(dom.window.document, dom.window);
            container.innerHTML = getLoadingHtml();
            expect(container.querySelectorAll('.gm-skeleton').length).toBeGreaterThan(10);

            // Simulate real render
            container.innerHTML = `
                <div class="gm-table-wrap">
                    <table class="gm-table">
                        <tbody><tr><td>#TICKET-0001</td><td>Found bug</td></tr></tbody>
                    </table>
                </div>`;

            expect(container.querySelectorAll('.gm-skeleton').length).toBe(0);
            expect(container.textContent).toContain('TICKET-0001');
        });
    });

    describe('3. Buy Me a Coffee Skeleton Loader (subscription-view.ts)', () => {
        it('renders silhouettes for the 3 pre-defined donation tier buttons and custom amount card', () => {
            const html = SubscriptionView.loadingHtml();

            // Accessibility and wrapper
            expect(html).toContain('class="gm-subscription-skeleton"');
            expect(html).toContain('aria-busy="true"');
            expect(html).toContain('aria-label="Loading donation options"');

            // No raw loading text or spinner
            expect(html).not.toContain('<div class="gm-empty-title">Loading…</div>');
            expect(html).not.toContain('ph-circle-notch');

            const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="subscription-container">${html}</div></body></html>`);
            const container = dom.window.document.getElementById('subscription-container');

            // 3 donation tier button silhouettes in .gm-sub-plans-grid
            const plansGrid = container.querySelector('.gm-sub-plans-grid');
            expect(plansGrid).not.toBeNull();
            const planCards = plansGrid.querySelectorAll('.gm-skeleton-card');
            expect(planCards.length).toBe(3);

            // Custom amount silhouette exists
            const skeletons = container.querySelectorAll('.gm-skeleton');
            expect(skeletons.length).toBeGreaterThan(10);
        });
    });

    describe('4. Settings Matchup Views (svs-matchup.js, gvg-matchup.js, cross-rank)', () => {

        describe('SvS Matchup (svs-matchup.js)', () => {
            const svsCode = read('svs-matchup.js');

            function setupSvsLoadingHtml(doc, win) {
                const fnMatch = svsCode.match(/function loadingHtml\(\)[\s\S]*?\n    \}/);
                expect(fnMatch).not.toBeNull();
                return new Function('document', 'window', `
                    ${fnMatch[0]}
                    return loadingHtml;
                `)(doc, win);
            }

            it('renders silhouette of two alliance blocks (Server A vs Server B) and roster lines', () => {
                const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="svs-matchup-container"></div></body></html>`);
                const getLoadingHtml = setupSvsLoadingHtml(dom.window.document, dom.window);
                const html = getLoadingHtml();

                expect(html).toContain('class="gm-matchup-skeleton"');
                expect(html).toContain('aria-busy="true"');
                expect(html).not.toContain('Loading…');
                expect(html).not.toContain('ph-circle-notch');

                const container = dom.window.document.getElementById('svs-matchup-container');
                container.innerHTML = html;

                // Two alliance columns
                const twoCols = container.querySelectorAll('.gm-matchup-2col');
                expect(twoCols.length).toBe(2); // Top selector cards & bottom side-by-side roster blocks

                // Avatar and text lines for rosters
                const avatars = container.querySelectorAll('.gm-skeleton-avatar');
                expect(avatars.length).toBe(10); // 5 rows * 2 sides
            });
        });

        describe('GvG Matchup (gvg-matchup.js)', () => {
            const gvgCode = read('gvg-matchup.js');

            function setupGvgLoadingHtml(doc, win) {
                const fnMatch = gvgCode.match(/function loadingHtml\(\)[\s\S]*?\n    \}/);
                expect(fnMatch).not.toBeNull();
                return new Function('document', 'window', `
                    ${fnMatch[0]}
                    return loadingHtml;
                `)(doc, win);
            }

            it('renders silhouette of two alliance blocks (Defender vs Opponent) and roster lines', () => {
                const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="gvg-matchup-container"></div></body></html>`);
                const getLoadingHtml = setupGvgLoadingHtml(dom.window.document, dom.window);
                const html = getLoadingHtml();

                expect(html).toContain('class="gm-matchup-skeleton"');
                expect(html).toContain('aria-busy="true"');
                expect(html).not.toContain('Loading…');
                expect(html).not.toContain('ph-circle-notch');

                const container = dom.window.document.getElementById('gvg-matchup-container');
                container.innerHTML = html;

                const twoCols = container.querySelectorAll('.gm-matchup-2col');
                expect(twoCols.length).toBe(2);

                const avatars = container.querySelectorAll('.gm-skeleton-avatar');
                expect(avatars.length).toBe(10);
            });
        });

        describe('Draft Scouting (CrossRankView & cross-rank.js)', () => {
            it('renders draft ranking table silhouette with filter toolbar', () => {
                const html = CrossRankView.loadingHtml();

                expect(html).toContain('class="gm-cross-rank-skeleton"');
                expect(html).toContain('aria-busy="true"');
                expect(html).not.toContain('Loading cross-guild migration scouting data...');

                const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="cross-rank-container">${html}</div></body></html>`);
                const container = dom.window.document.getElementById('cross-rank-container');

                const rows = container.querySelectorAll('tbody tr');
                expect(rows.length).toBe(5);

                const avatars = container.querySelectorAll('.gm-skeleton-avatar');
                expect(avatars.length).toBe(5);
            });
        });
    });
});
