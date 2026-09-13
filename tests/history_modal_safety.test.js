import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Ticket 1.1 — ar_subtitle i18n tag and Event History modal safety', () => {
  it('i18n dictionaries and index.html define a descriptive ar_subtitle string', () => {
    const html = read('index.html');
    expect(html).toContain('data-i18n="ar_subtitle"');
    expect(html).toContain('Track and manage Arms Race stages &amp; scores');

    const i18nJs = read('src/core/i18n/i18n.dictionary.ts');
    expect(i18nJs).toMatch(/ar_subtitle:\s*'Track and manage Arms Race stages & scores'/);

    const i18nTs = read('src/core/i18n/i18n.dictionary.ts');
    expect(i18nTs).toMatch(/ar_subtitle:\s*'Track and manage Arms Race stages & scores'/);
  });

  it('HistoryView modal moves delete action away from header close icon and into modal footer', () => {
    const historyJs = read('src/modules/history/views/HistoryView.ts');

    // Header close icon is isolated and no longer paired with delete button
    expect(historyJs).not.toMatch(/deleteBtnHtml\s*\+\s*['"]<button[^>]+id="history-modal-close"/);
    expect(historyJs).not.toMatch(/id="history-modal-close"[^>]*>[\s\S]{0,100}deleteBtnHtml/);

    // Delete button is housed in the bottom modal footer
    expect(historyJs).toContain('gm-modal-footer');
    expect(historyJs).toContain('history-modal-footer-left');
    expect(historyJs).toContain('history-modal-footer-close');

    // Footer structure positions delete on the left and close on the right
    const footerSnippet = historyJs.slice(historyJs.indexOf('gm-modal-footer'));
    expect(footerSnippet).toContain('history-modal-footer-left');
    expect(footerSnippet).toContain('history-modal-footer-close');
    expect(footerSnippet.indexOf('history-modal-footer-left')).toBeLessThan(footerSnippet.indexOf('history-modal-footer-close'));
  });

  it('HistoryView requires explicit confirmation dialog before executing session deletion', () => {
    const historyJs = read('src/modules/history/views/HistoryView.ts');
    expect(historyJs).toContain('confirm_delete_session_title');
    expect(historyJs).toContain('confirm_delete_session_body');
    // Verifies defensive fallback to window.showConfirm / window.confirm
    expect(historyJs).toMatch(/typeof\s+(?:window|w)\.showConfirm\s*===\s*'function'/);
  });
});
