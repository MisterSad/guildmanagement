/**
 * tests/field_labels.test.js
 *
 * Every form field in index.html has an accessible name (M5): a <label for>,
 * a wrapping <label>, aria-label, aria-labelledby or title. A placeholder is
 * not one -- it disappears as soon as someone types. 46 of the 86 fields had
 * none. Fields built by the views are judged in a real browser by axe-core
 * (e2e/a11y.spec.js), on every screen it opens.
 */
import { describe, it, expect } from 'vitest';
import { appHtml } from './helpers/app-html.js';

const html = appHtml();

function unnamedFields(doc) {
  return [...doc.querySelectorAll('input, select, textarea')]
    .filter((el) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
      const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      return !(
        (el.getAttribute('aria-label') || '').trim() ||
        (labelledBy.length && labelledBy.every((id) => doc.getElementById(id))) ||
        (el.getAttribute('title') || '').trim() ||
        el.closest('label') ||
        (el.id && doc.querySelector(`label[for="${el.id}"]`))
      );
    })
    .map((el) => `${el.tagName.toLowerCase()}#${el.id || '(no id)'}`);
}

describe('form field names in index.html', () => {
  it('names every field', () => {
    document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>/i, '');
    expect(document.querySelectorAll('input, select, textarea').length).toBeGreaterThan(80);
    expect(unnamedFields(document)).toEqual([]);
  });

  it('flags a field named only by its placeholder (the check is not vacuous)', () => {
    document.body.innerHTML = '<input id="x" placeholder="Search..."><label for="y">Y</label><input id="y">';
    expect(unnamedFields(document)).toEqual(['input#x']);
  });
});
