import { describe, it, expect } from 'vitest';
import { appHtml } from './helpers/app-html.js';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Search Input Clear Button Feature', () => {
  it('index.html includes clear buttons on primary search inputs', () => {
    const html = appHtml();
    expect(html).toContain('id="member-search-admin"');
    expect(html).toContain('id="banned-search"');
    expect(html).toContain('id="ocr-filter-search"');

    // Check that member-search-admin has a clear button inside its wrapper
    const adminSearchSnippet = html.slice(
      html.indexOf('id="member-search-admin"'),
      html.indexOf('id="member-search-admin"') + 500
    );
    expect(adminSearchSnippet).toContain('gm-search-clear-btn');
    expect(adminSearchSnippet).toContain('data-gm-search-clear');
    // 'cancel' was a Material Symbols ligature; that font is gone.
    expect(adminSearchSnippet).toContain('ph-x-circle');
  });

  it('shell.css and components.css define .gm-search-clear-btn styles', () => {
    const shellCss = read('shell.css');
    const compCss = read('components.css');
    expect(shellCss).toContain('.gm-search-clear-btn');
    expect(shellCss).toContain(':not(:placeholder-shown) ~ .gm-search-clear-btn');
    expect(compCss).toContain('.gm-search-clear-btn');
  });

  // The handler itself runs against a DOM in tests/form_controls.test.js.
});
