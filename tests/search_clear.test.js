import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Search Input Clear Button Feature', () => {
  it('index.html includes clear buttons on primary search inputs', () => {
    const html = read('index.html');
    expect(html).toContain('id="member-search-admin"');
    expect(html).toContain('id="banned-search"');
    expect(html).toContain('id="ocr-filter-search"');
    
    // Check that member-search-admin has a clear button inside its wrapper
    const adminSearchSnippet = html.slice(html.indexOf('id="member-search-admin"'), html.indexOf('id="member-search-admin"') + 500);
    expect(adminSearchSnippet).toContain('gm-search-clear-btn');
    expect(adminSearchSnippet).toContain('data-gm-search-clear');
    expect(adminSearchSnippet).toContain('cancel');
  });

  it('shell.css and components.css define .gm-search-clear-btn styles', () => {
    const shellCss = read('shell.css');
    const compCss = read('components.css');
    expect(shellCss).toContain('.gm-search-clear-btn');
    expect(shellCss).toContain(':not(:placeholder-shown) ~ .gm-search-clear-btn');
    expect(compCss).toContain('.gm-search-clear-btn');
  });

  it('shell.js defines and registers wireSearchClearButtons', () => {
    const shellJs = read('shell.js');
    expect(shellJs).toContain('function wireSearchClearButtons()');
    expect(shellJs).toContain('wireSearchClearButtons();');
  });

  it('delegated clear handler resets input value, dispatches input/change events and focuses', () => {
    // Setup simulated DOM in jsdom
    document.body.innerHTML = `
      <div class="gm-input-with-icon">
        <i class="ph ph-magnifying-glass gm-icon"></i>
        <input type="text" id="member-search-admin" class="gm-input" placeholder="Search..." value="InitialSearch">
        <button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search">
          <span class="material-symbols-rounded">cancel</span>
        </button>
      </div>
    `;

    // Attach delegated click listener as in shell.js
    let inputEventFired = false;
    let changeEventFired = false;
    const input = document.getElementById('member-search-admin');
    input.addEventListener('input', () => { inputEventFired = true; });
    input.addEventListener('change', () => { changeEventFired = true; });

    document.addEventListener('input', function (e) {
      const inp = e.target;
      if (!inp || inp.tagName !== 'INPUT') return;
      const wrap = inp.closest('.gm-input-with-icon') || inp.parentElement;
      if (!wrap) return;
      const clearBtn = wrap.querySelector('[data-gm-search-clear]');
      if (!clearBtn) return;
      if (inp.value && inp.value.trim().length > 0) {
        clearBtn.classList.add('gm-visible');
      } else {
        clearBtn.classList.remove('gm-visible');
      }
    });

    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-gm-search-clear], .gm-search-clear-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || btn.parentElement;
      const targetInput = wrap ? wrap.querySelector('input') : null;
      if (!targetInput) return;
      targetInput.value = '';
      btn.classList.remove('gm-visible');
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      targetInput.focus();
    });

    const clearBtn = document.querySelector('.gm-search-clear-btn');
    const span = clearBtn.querySelector('.material-symbols-rounded');
    
    // Click on inner span to test event bubbling & .closest()
    span.click();

    expect(input.value).toBe('');
    expect(inputEventFired).toBe(true);
    expect(changeEventFired).toBe(true);
    expect(clearBtn.classList.contains('gm-visible')).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});
