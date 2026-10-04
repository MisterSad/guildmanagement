import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { loadingHtml as ticketsLoadingHtml } from '../src/modules/tickets/views/TicketsView.ts';

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

  describe('2. Bug Tickets Skeleton Loader (TicketsView.ts)', () => {
    const ticketsCode = read('src/modules/tickets/views/TicketsView.ts');

    it('replaces raw "Loading tickets..." text and lonely spinner with card silhouettes', () => {
      expect(ticketsCode).not.toContain('<div class="gm-empty-title">Loading tickets...</div>');

      const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="tickets-container"></div></body></html>`);
      const html = ticketsLoadingHtml();

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

      const getLoadingHtml = ticketsLoadingHtml;
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
});
