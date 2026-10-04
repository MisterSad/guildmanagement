/**
 * tests/form_controls.test.js
 *
 * The sign-in screen's password eye and the search clear buttons
 * (src/core/dom/form-controls.ts), run against a DOM. They are wired at boot,
 * before anyone signs in (M5: the shell that used to wire them is admin-only).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { wireLoginPasswordToggle, wireSearchClearButtons } from '../src/core/dom/form-controls';

describe('password show/hide toggle', () => {
  it('flips the field between password and text, and the eye icon with it', () => {
    document.body.innerHTML = `
      <div class="gm-input-with-icon">
        <input type="password" id="pw" value="secret">
        <button type="button" data-gm-pwd-toggle><i class="ph ph-eye"></i></button>
      </div>`;
    wireLoginPasswordToggle();
    wireLoginPasswordToggle(); // idempotent: a second call must not add a second listener
    const input = document.getElementById('pw');
    const btn = document.querySelector('[data-gm-pwd-toggle]');
    btn.click();
    expect(input.type).toBe('text');
    expect(btn.querySelector('i').className).toBe('ph ph-eye-slash');
    btn.click();
    expect(input.type).toBe('password');
    expect(btn.querySelector('i').className).toBe('ph ph-eye');
  });
});

describe('search clear button', () => {
  beforeAll(() => { wireSearchClearButtons(); wireSearchClearButtons(); });

  it('shows while the field has text and hides when it is emptied', () => {
    document.body.innerHTML = `
      <div class="gm-input-with-icon">
        <input type="text" id="q">
        <button type="button" class="gm-search-clear-btn" data-gm-search-clear><i class="ph ph-x-circle"></i></button>
      </div>`;
    const input = document.getElementById('q');
    const btn = document.querySelector('[data-gm-search-clear]');
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.classList.contains('gm-visible')).toBe(true);
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.classList.contains('gm-visible')).toBe(false);
  });

  it('clears the field, tells its listeners once, and focuses it', () => {
    document.body.innerHTML = `
      <div class="gm-input-with-icon">
        <input type="text" id="q" value="Initial">
        <button type="button" class="gm-search-clear-btn gm-visible" data-gm-search-clear><i class="ph ph-x-circle"></i></button>
      </div>`;
    const input = document.getElementById('q');
    const events = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    document.querySelector('[data-gm-search-clear] i').click();
    expect(input.value).toBe('');
    expect(events).toEqual(['input', 'change']);
    expect(document.querySelector('[data-gm-search-clear]').classList.contains('gm-visible')).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});
