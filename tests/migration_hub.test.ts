/**
 * tests/migration_hub.test.ts
 *
 * Unit tests for the Migration Hub view module, markdown sanitizer, and scope handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MigrationHubView } from '../src/modules/migration/views/MigrationHubView';
import { NAV_ITEMS } from '../src/modules/shell/views/ShellView';
import fs from 'fs';
import path from 'path';

describe('Migration Hub', () => {
  let view: MigrationHubView;

  beforeEach(() => {
    view = new MigrationHubView();
  });

  afterEach(() => {
    view.destroy();
    document.body.innerHTML = '';
  });

  describe('Navigation Invariant', () => {
    it('registers migration-hub in NAV_ITEMS under admin section with adminOnly', () => {
      const item = NAV_ITEMS.find((i) => i.id === 'migration-hub');
      expect(item).toBeDefined();
      expect(item?.section).toBe('admin');
      expect(item?.adminOnly).toBe(true);
      expect(item?.tabId).toBe('admin-migration-hub');
    });

    it('contains admin-migration-hub panel in index.html', () => {
      const htmlPath = path.resolve(__dirname, '../index.html');
      const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
      expect(htmlContent).toContain('id="admin-migration-hub"');
      expect(htmlContent).toContain('id="migration-hub-pages-container"');
      expect(htmlContent).toContain('id="migration-hub-dropzone"');
      expect(htmlContent).toContain('id="migration-hub-lightbox"');
    });
  });

  describe('Markdown Renderer & XSS Sanitization', () => {
    it('sanitizes malicious script tags to prevent XSS', () => {
      const dirty = '<script>alert("xss")</script> Hello **World**';
      const rendered = view.renderMarkdown(dirty);
      expect(rendered).not.toContain('<script>');
      expect(rendered).toContain('&lt;script&gt;');
      expect(rendered).toContain('<strong>World</strong>');
    });

    it('sanitizes event handler injections in HTML tags', () => {
      const dirty = '<img src=x onerror=alert(1)>';
      const rendered = view.renderMarkdown(dirty);
      expect(rendered).not.toContain('<img');
      expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('renders headings correctly', () => {
      const text = '# Main Title\n## Sub Title\n### Small Header';
      const rendered = view.renderMarkdown(text);
      expect(rendered).toContain('<h1');
      expect(rendered).toContain('Main Title</h1>');
      expect(rendered).toContain('<h2');
      expect(rendered).toContain('Sub Title</h2>');
      expect(rendered).toContain('<h3');
      expect(rendered).toContain('Small Header</h3>');
    });

    it('renders bold, italic, code, quotes, and lists', () => {
      const text = '**bold** and *italic* and `code snippet`\n> Important quote\n- Item A\n- Item B';
      const rendered = view.renderMarkdown(text);
      expect(rendered).toContain('<strong>bold</strong>');
      expect(rendered).toContain('<em>italic</em>');
      expect(rendered).toContain('<code');
      expect(rendered).toContain('code snippet</code>');
      expect(rendered).toContain('<blockquote');
      expect(rendered).toContain('Important quote</blockquote>');
      expect(rendered).toContain('<li');
      expect(rendered).toContain('Item A</li>');
      expect(rendered).toContain('Item B</li>');
    });

    it('renders markdown tables correctly', () => {
      const tableText = [
        '| Target | Server | Power |',
        '| :--- | :---: | :---: |',
        '| AlphaLead | 1089 | 150M |',
        '| BetaLead | 1089 | 120M |'
      ].join('\n');

      const rendered = view.renderMarkdown(tableText);
      expect(rendered).toContain('<table');
      expect(rendered).toContain('<thead');
      expect(rendered).toContain('<th');
      expect(rendered).toContain('Target</th>');
      expect(rendered).toContain('AlphaLead</td>');
      expect(rendered).toContain('150M</td>');
    });
  });

  describe('Scope Switching and State', () => {
    it('switches between guild and server scopes', () => {
      // Setup minimal DOM elements required for scope toggle
      document.body.innerHTML = `
        <button id="migration-hub-scope-guild-btn" class="active"></button>
        <button id="migration-hub-scope-server-btn"></button>
        <div id="migration-hub-pages-container"></div>
        <div id="migration-hub-view-card"></div>
        <div id="migration-hub-edit-card"></div>
      `;

      view.init();
      // Initially guild scope
      expect((view as any).filterState.scope).toBe('guild');

      // Switch to server
      view.switchScope('server');
      expect((view as any).filterState.scope).toBe('server');

      // Switch back to guild
      view.switchScope('guild');
      expect((view as any).filterState.scope).toBe('guild');
    });

    it('toggles between empty and detail states without destroying DOM structure', () => {
      document.body.innerHTML = `
        <div id="migration-hub-view-card">
          <div id="migration-hub-view-empty" style="display:none;">
            <p id="migration-hub-empty-desc"></p>
            <button id="migration-hub-empty-new-btn"></button>
          </div>
          <div id="migration-hub-view-detail" style="display:none;">
            <span id="migration-hub-view-category-badge"></span>
            <span id="migration-hub-view-pinned-badge" style="display:none;"></span>
            <span id="migration-hub-view-scope-badge"></span>
            <h2 id="migration-hub-view-title"></h2>
            <div id="migration-hub-view-meta"></div>
            <div id="migration-hub-view-content"></div>
            <div id="migration-hub-view-gallery-section" style="display:none;">
              <span id="migration-hub-view-attachments-count">0</span>
              <div id="migration-hub-view-attachments"></div>
            </div>
          </div>
        </div>
        <div id="migration-hub-edit-card" style="display:none;"></div>
      `;

      // 1. Initial state: no active page -> empty state displayed
      (view as any).pages = [];
      (view as any).filterState.activePageId = null;
      (view as any).renderActivePage();

      const emptyEl = document.getElementById('migration-hub-view-empty');
      const detailEl = document.getElementById('migration-hub-view-detail');
      expect(emptyEl?.style.display).toBe('block');
      expect(detailEl?.style.display).toBe('none');

      // 2. Add page and select it -> detail state displayed, title & content rendered
      (view as any).pages = [
        {
          id: 'test-page-1',
          scope: 'server',
          server_number: '1058',
          guild_id: null,
          category: 'recruitment',
          title: '[MTLH] Metalhead #1061',
          content: 'Test intel details',
          is_pinned: false,
          attachments: [],
          created_by_account_id: 'acc1',
          created_by_pseudo: 'HawkEye',
          updated_by_account_id: 'acc1',
          updated_by_pseudo: 'HawkEye',
          created_at: '2026-09-19T20:00:00Z',
          updated_at: '2026-09-19T20:00:00Z'
        }
      ];
      (view as any).filterState.activePageId = 'test-page-1';
      (view as any).renderActivePage();

      expect(emptyEl?.style.display).toBe('none');
      expect(detailEl?.style.display).toBe('block');

      const titleEl = document.getElementById('migration-hub-view-title');
      const contentEl = document.getElementById('migration-hub-view-content');
      const catBadge = document.getElementById('migration-hub-view-category-badge');

      expect(titleEl?.textContent).toBe('[MTLH] Metalhead #1061');
      expect(contentEl?.innerHTML).toContain('Test intel details');
      expect(catBadge?.textContent).toBe('Recruitment');

      // 3. Clear active page again -> empty state displayed without errors
      (view as any).filterState.activePageId = null;
      (view as any).renderActivePage();

      expect(emptyEl?.style.display).toBe('block');
      expect(detailEl?.style.display).toBe('none');

      // 4. Re-select page -> detail state works perfectly (elements were NOT destroyed)
      (view as any).filterState.activePageId = 'test-page-1';
      (view as any).renderActivePage();

      expect(emptyEl?.style.display).toBe('none');
      expect(detailEl?.style.display).toBe('block');
      expect(titleEl?.textContent).toBe('[MTLH] Metalhead #1061');
    });
  });
});
