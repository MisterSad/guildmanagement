/**
 * src/components/ui/Input.ts
 *
 * Harmonized text/numeric input (shadcn/ui philosophy).
 *
 * Keeps a native <input> carrying the caller's id so legacy imperative reads
 * (byId(id).value) and submit handlers keep working. Provides an optional
 * inline error state (aria-invalid + visible message) and a mono variant for
 * role/webhook IDs.
 */

import { cn } from '../../core/utils/cn';
import { escapeHTML } from '../../core/utils/text';

export type InputType = 'text' | 'number' | 'url' | 'email';

export interface InputProps {
  id: string;
  type?: InputType;
  value?: string | number;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  min?: number | string;
  max?: number | string;
  maxLength?: number;
  pattern?: string;
  /** Monospace font (role IDs, webhook URLs). */
  mono?: boolean;
  size?: 'sm' | 'md';
  /** Non-empty renders the field in the error state (aria-invalid + message). */
  error?: string | null;
  className?: string;
  onChange?: (value: string, input: HTMLInputElement) => void;
}

function escapeAttr(value: string | number | boolean | undefined): string {
  return value === undefined ? '' : escapeHTML(String(value));
}

function inputAttrs(props: InputProps): string {
  let html = 'type="' + (props.type ?? 'text') + '"';
  html += ' id="' + escapeAttr(props.id) + '"';
  html += ' class="gm-ui-input-field' + (props.mono ? ' gm-ui-input-mono' : '') + '"';
  if (props.value !== undefined && props.value !== null) html += ' value="' + escapeAttr(props.value) + '"';
  if (props.placeholder) html += ' placeholder="' + escapeAttr(props.placeholder) + '"';
  if (props.required) html += ' required';
  if (props.disabled) html += ' disabled';
  if (props.min !== undefined && props.min !== null) html += ' min="' + escapeAttr(props.min) + '"';
  if (props.max !== undefined && props.max !== null) html += ' max="' + escapeAttr(props.max) + '"';
  if (props.maxLength !== undefined) html += ' maxlength="' + escapeAttr(props.maxLength) + '"';
  if (props.pattern) html += ' pattern="' + escapeAttr(props.pattern) + '"';
  const hasError = Boolean(props.error);
  if (hasError) html += ' aria-invalid="true"';
  return html;
}

export function renderInput(props: InputProps): string {
  const sizeCls = props.size === 'sm' ? ' gm-ui-input-sm' : ' gm-ui-input-md';
  const errorCls = props.error ? ' gm-ui-input-invalid' : '';
  const cls = 'gm-ui-input' + sizeCls + errorCls + (props.className ? ' ' + props.className : '');
  const errorHtml = props.error
    ? '<span class="gm-ui-input-error" role="alert">' + escapeHTML(props.error) + '</span>'
    : '';

  return (
    '<span class="' + cn(cls) + '">' +
      '<input ' + inputAttrs(props) + '>' +
      errorHtml +
    '</span>'
  );
}

export function createInput(props: InputProps): HTMLSpanElement {
  const host = document.createElement('span');
  host.innerHTML = renderInput(props);
  const wrapper = host.firstElementChild as HTMLSpanElement;
  const input = wrapper.querySelector<HTMLInputElement>('.gm-ui-input-field') as HTMLInputElement;
  input.addEventListener('input', () => {
    props.onChange?.(input.value, input);
  });
  return wrapper;
}

/** Imperative error-state toggle for a rendered input's field. */
export function applyInputError(input: HTMLInputElement | null, error: string | null): void {
  if (!input) return;
  const wrapper = input.closest('.gm-ui-input');
  if (error) {
    input.setAttribute('aria-invalid', 'true');
    wrapper?.classList.add('gm-ui-input-invalid');
  } else {
    input.removeAttribute('aria-invalid');
    wrapper?.classList.remove('gm-ui-input-invalid');
  }
  if (wrapper) {
    let errorEl = wrapper.querySelector<HTMLElement>('.gm-ui-input-error');
    if (error) {
      if (!errorEl) {
        errorEl = document.createElement('span');
        errorEl.className = 'gm-ui-input-error';
        errorEl.setAttribute('role', 'alert');
        wrapper.appendChild(errorEl);
      }
      errorEl.textContent = error;
    } else if (errorEl) {
      errorEl.remove();
    }
  }
}

/** Returns the native input inside a gm-ui-input wrapper, if any. */
export function inputField(wrapper: HTMLElement | null): HTMLInputElement | null {
  return wrapper ? wrapper.querySelector<HTMLInputElement>('.gm-ui-input-field') : null;
}