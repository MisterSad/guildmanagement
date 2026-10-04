import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initOcrDropdown } from '../src/modules/app/ocr/ocr.controller';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Ticket 2.1 — Compact OCR Scanners Dropdown Menu', () => {

    describe('1. Static Template & Markup Invariants (index.html & components.css)', () => {
        const html = read('index.html');
        const css = read('components.css');
        const app = read('src/modules/app/ocr/ocr.controller.ts');

        it('replaces horizontal 8-button row with single compact trigger button in .gm-ocr-toolbar', () => {
            const toolbarMatch = html.match(/<div class="gm-ocr-toolbar[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<form id="add-member-form"/);
            expect(toolbarMatch).not.toBeNull();
            const toolbarContent = toolbarMatch[1];

            // 1. The old static header label "AI OCR Metric Scanners:" is removed from the raw bar
            expect(toolbarContent).not.toContain('AI OCR Metric Scanners:');

            // 2. The single compact trigger button exists
            expect(toolbarContent).toContain('id="ocr-dropdown-trigger"');
            expect(toolbarContent).toMatch(/class="gm-btn gm-btn-sm ocr-dropdown-trigger[ "]/);
            expect(toolbarContent).toContain('ph ph-sparkle');
            expect(toolbarContent).toContain('AI Metric Scanners');
            expect(toolbarContent).toContain('ph-caret-down');

            // 3. The toolbar contains the dropdown wrapper
            expect(toolbarContent).toContain('id="ocr-scanners-dropdown"');
            expect(toolbarContent).toContain('id="ocr-dropdown-menu"');

            // 4. The 8 individual buttons are NOT direct children of .gm-ocr-toolbar anymore
            const directChildButtonsRegex = /<div class="gm-ocr-toolbar[^"]*"[^>]*>\s*(<button[\s\S]*?<\/button>\s*){2,}/;
            expect(directChildButtonsRegex.test(html)).toBe(false);
        });

        it('floating dropdown menu contains all 8 OCR metric triggers with original labels and icons', () => {
            const menuMatch = html.match(/<div[^>]+id="ocr-dropdown-menu"[^>]*>([\s\S]*?)<\/div>/);
            expect(menuMatch).not.toBeNull();
            const menuContent = menuMatch[1];

            const expectedMetrics = [
                { metric: 'members', label: '1. Members OCR', icon: 'ph-users' },
                { metric: 'power', label: '2. Power OCR', icon: 'ph-sword' },
                { metric: 'fleet', label: '3. Fleet OCR', icon: 'ph-shooting-star' },
                { metric: 'tech', label: '4. Tech OCR', icon: 'ph-atom' },
                { metric: 'flagship', label: '5. Flagship OCR', icon: 'ph-rocket' },
                { metric: 'champs', label: '6. Champs OCR', icon: 'ph-crown' },
                { metric: 'crew', label: '7. Crew OCR', icon: 'ph-users-three' },
                { metric: 'glory', label: '8. Glory OCR', icon: 'ph-trophy' }
            ];

            expectedMetrics.forEach(({ metric, label, icon }) => {
                expect(menuContent).toContain(`data-metric="${metric}"`);
                expect(menuContent).toContain(label);
                expect(menuContent).toContain(icon);
                expect(menuContent).toContain('btn-ocr-trigger');
            });
        });

        it('components.css defines styles for .gm-dropdown, .gm-dropdown-menu, and .gm-dropdown-item', () => {
            expect(css).toContain('.gm-dropdown');
            expect(css).toContain('.gm-dropdown-menu');
            expect(css).toContain('.gm-dropdown-item');
            expect(css).toContain('.ocr-dropdown-trigger[aria-expanded="true"] .ocr-dropdown-caret');
        });

        it('i18n dictionary defines ocr_ai_metric_scanners key', () => {
            const i18nJs = read('src/core/i18n/i18n.dictionary.ts');
            expect(i18nJs).toContain('ocr_ai_metric_scanners');
            expect(i18nJs).toContain('AI Metric Scanners');

            const i18nTs = read('src/core/i18n/i18n.dictionary.ts');
            expect(i18nTs).toContain('ocr_ai_metric_scanners');
            expect(i18nTs).toContain('AI Metric Scanners');
        });

        it('defines initOcrDropdown in the OCR controller', () => {
            // startAdmin() calls it when the admin chunk loads (tests/admin_shell.test.js).
            expect(app).toContain('function initOcrDropdown');
        });
    });

    describe('2. Interactive Behavior (JSDOM Simulation & Event Handling)', () => {
        let _container;
        let trigger;
        let menu;
        let outsideElem;

        function setupInitOcrDropdown() {
            // Ported to /src (Strangler cutover): use the real typed module.
            return initOcrDropdown;
        }

        beforeEach(() => {
            document.body.innerHTML = `
                <div id="outside-area" style="padding: 20px;">Outside content</div>
                <div class="gm-ocr-toolbar">
                    <div class="gm-dropdown gm-ocr-dropdown" id="ocr-scanners-dropdown">
                        <button type="button" id="ocr-dropdown-trigger" class="gm-btn gm-btn-sm ocr-dropdown-trigger" aria-haspopup="true" aria-expanded="false">
                            <i class="ph-duotone ph-sparkle"></i>
                            <span>AI Metric Scanners</span>
                            <i class="ph ph-caret-down ocr-dropdown-caret"></i>
                        </button>
                        <div class="gm-dropdown-menu gm-ocr-menu" id="ocr-dropdown-menu" style="display:none;">
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="members"><i class="ph ph-users"></i> 1. Members OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="power"><i class="ph ph-sword"></i> 2. Power OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="fleet"><i class="ph ph-swords"></i> 3. Fleet OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="tech"><i class="ph ph-atom"></i> 4. Tech OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="flagship"><i class="ph ph-rocket"></i> 5. Flagship OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="champs"><i class="ph ph-crown"></i> 6. Champs OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="crew"><i class="ph ph-users-three"></i> 7. Crew OCR</button>
                            <button type="button" class="btn-ocr-trigger gm-dropdown-item" data-metric="glory"><i class="ph ph-trophy"></i> 8. Glory OCR</button>
                        </div>
                    </div>
                </div>
            `;

            const initOcrDropdown = setupInitOcrDropdown();
            initOcrDropdown();

            _container = document.getElementById('ocr-scanners-dropdown');
            trigger = document.getElementById('ocr-dropdown-trigger');
            menu = document.getElementById('ocr-dropdown-menu');
            outsideElem = document.getElementById('outside-area');
        });

        afterEach(() => {
            document.body.innerHTML = '';
        });

        it('opens and closes menu when clicking on the trigger button', () => {
            expect(menu.style.display).toBe('none');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');

            // 1st click -> Open
            trigger.click();
            expect(menu.style.display).toBe('flex');
            expect(menu.classList.contains('show')).toBe(true);
            expect(trigger.getAttribute('aria-expanded')).toBe('true');

            // 2nd click -> Close
            trigger.click();
            expect(menu.style.display).toBe('none');
            expect(menu.classList.contains('show')).toBe(false);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        });

        it('automatically closes menu when clicking outside the dropdown container', () => {
            // Open dropdown
            trigger.click();
            expect(menu.style.display).toBe('flex');
            expect(trigger.getAttribute('aria-expanded')).toBe('true');

            // Click outside
            outsideElem.click();
            expect(menu.style.display).toBe('none');
            expect(menu.classList.contains('show')).toBe(false);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        });

        it('automatically closes menu when selecting any OCR scan option', () => {
            // Open dropdown
            trigger.click();
            expect(menu.style.display).toBe('flex');

            // Click on 'Glory OCR' item
            const gloryItem = menu.querySelector('button[data-metric="glory"]');
            expect(gloryItem).not.toBeNull();
            gloryItem.click();

            // Menu should close
            expect(menu.style.display).toBe('none');
            expect(menu.classList.contains('show')).toBe(false);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        });

        it('automatically closes menu when pressing Escape key', () => {
            // Open dropdown
            trigger.click();
            expect(menu.style.display).toBe('flex');

            // Press Escape
            const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
            document.dispatchEvent(escEvent);

            expect(menu.style.display).toBe('none');
            expect(menu.classList.contains('show')).toBe(false);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        });
    });
});
