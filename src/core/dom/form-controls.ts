/**
 * src/core/dom/form-controls.ts
 *
 * Two document-wide form behaviours the sign-in screen needs before anyone has
 * signed in: the password show/hide toggle and the search-field clear button.
 * They lived in ShellView.init(); the shell is the admin chrome and, since M5,
 * loads only with the admin chunk, so they moved here and run at boot.
 */

let passwordToggleWired = false;
let searchClearWired = false;

/** Wires every `[data-gm-pwd-toggle]` button to show/hide its password field. */
export function wireLoginPasswordToggle(): void {
  if (passwordToggleWired || typeof document === 'undefined') return;
  passwordToggleWired = true;
  document.querySelectorAll('[data-gm-pwd-toggle]').forEach((btn) => {
    const wrap = btn.closest('.gm-input-with-icon');
    const input = (
      wrap ? wrap.querySelector('input[type="password"], input[type="text"]') : null
    ) as HTMLInputElement | null;
    if (!input) return;
    btn.addEventListener('click', () => {
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) icon.className = isPwd ? 'ph ph-eye-slash' : 'ph ph-eye';
    });
  });
}

/** Shows a search field's clear button while it has text, and clears it on click. */
export function wireSearchClearButtons(): void {
  if (searchClearWired || typeof document === 'undefined') return;
  searchClearWired = true;
  document.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement | null;
    if (!input || input.tagName !== 'INPUT') return;
    const wrap =
      input.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || input.parentElement;
    if (!wrap) return;
    const clearBtn = wrap.querySelector('[data-gm-search-clear], .gm-search-clear-btn');
    if (!clearBtn) return;
    if (input.value && input.value.trim().length > 0) {
      clearBtn.classList.add('gm-visible');
    } else {
      clearBtn.classList.remove('gm-visible');
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const btn = target ? target.closest('[data-gm-search-clear], .gm-search-clear-btn') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap =
      btn.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || btn.parentElement;
    const input = (wrap ? wrap.querySelector('input') : null) as HTMLInputElement | null;
    if (!input) return;
    input.value = '';
    btn.classList.remove('gm-visible');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  });
}

/** Test hook: lets a test wire the behaviours again on a fresh DOM. */
export function _resetFormControlsForTesting(): void {
  passwordToggleWired = false;
  searchClearWired = false;
}
