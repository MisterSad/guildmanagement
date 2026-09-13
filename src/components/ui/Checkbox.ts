/**
 * src/components/ui/Checkbox.ts
 *
 * Accessible checkbox (shadcn/ui philosophy) with indeterminate support.
 *
 * Same backward-compatibility contract as Switch: the native checkbox input
 * keeps the caller's id so byId(id).checked and form submit handlers keep
 * working. Indeterminate is a DOM property (never an attribute): use
 * setIndeterminate() to toggle it; ARIA reflects `aria-checked="mixed"`.
 */

import { cva } from '../../core/utils/cva';
import { cn } from '../../core/utils/cn';
import { escapeHTML } from '../../core/utils/text';
import type { UiSize } from './types';

export interface CheckboxProps {
  id: string;
  label?: string;
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  size?: UiSize;
  accent?: 'default' | 'danger';
  className?: string;
  onChange?: (checked: boolean, input: HTMLInputElement) => void;
}

export const checkboxRecipe = cva('gm-ui-checkbox', {
  variants: {
    size: { sm: 'gm-ui-checkbox-sm', md: 'gm-ui-checkbox-md' },
    accent: {
      default: 'gm-ui-accent-default',
      danger: 'gm-ui-accent-danger'
    }
  },
  defaultVariants: { size: 'md', accent: 'default' }
});

export function checkboxClassList(props: CheckboxProps): string {
  return checkboxRecipe({ size: props.size, accent: props.accent });
}

function ariaCheckedFor(checked: boolean, indeterminate: boolean): string {
  return indeterminate ? 'mixed' : (checked ? 'true' : 'false');
}

export function renderCheckbox(props: CheckboxProps): string {
  const id = escapeHTML(props.id);
  const checked = props.checked === true;
  const indeterminate = props.indeterminate === true;
  const disabled = props.disabled === true;
  const label = props.label ? escapeHTML(props.label) : '';
  const cls = cn(checkboxClassList(props), props.className);
  const labelHtml = label
    ? '<span class="gm-ui-checkbox-label"><span class="gm-ui-checkbox-text">' + label + '</span></span>'
    : '';

  return (
    '<label class="' + cn(cls) + '">' +
      '<span class="gm-ui-checkbox-hit">' +
        '<input type="checkbox" class="gm-ui-checkbox-input" id="' + id + '"' +
          (checked ? ' checked' : '') +
          (disabled ? ' disabled' : '') +
          ' aria-checked="' + ariaCheckedFor(checked, indeterminate) + '"' +
          (disabled ? ' aria-disabled="true"' : '') +
          '>' +
        '<span class="gm-ui-checkbox-box"></span>' +
      '</span>' +
      labelHtml +
    '</label>'
  );
}

function syncCheckboxAria(input: HTMLInputElement): void {
  input.setAttribute('aria-checked', input.indeterminate ? 'mixed' : (input.checked ? 'true' : 'false'));
  if (input.disabled) input.setAttribute('aria-disabled', 'true');
  else input.removeAttribute('aria-disabled');
}

/** Builds a live checkbox element with change wiring. */
export function createCheckbox(props: CheckboxProps): HTMLLabelElement {
  const host = document.createElement('span');
  host.innerHTML = renderCheckbox(props);
  const label = host.firstElementChild as HTMLLabelElement;
  const input = label.querySelector<HTMLInputElement>('.gm-ui-checkbox-input') as HTMLInputElement;
  if (props.indeterminate === true) input.indeterminate = true;
  syncCheckboxAria(input);
  input.addEventListener('change', () => {
    syncCheckboxAria(input);
    props.onChange?.(input.checked, input);
  });
  return label;
}

/** Toggles the indeterminate state (DOM property) and mirrors ARIA. */
export function setIndeterminate(input: HTMLInputElement | null, indeterminate: boolean): void {
  if (!input) return;
  input.indeterminate = indeterminate;
  syncCheckboxAria(input);
}

/** Imperative state sync for a checkbox's native input. */
export function syncCheckbox(input: HTMLInputElement | null, partial: Pick<CheckboxProps, 'checked' | 'indeterminate' | 'disabled'> | undefined): void {
  if (!input) return;
  if (partial) {
    if (typeof partial.checked === 'boolean') input.checked = partial.checked;
    if (typeof partial.indeterminate === 'boolean') input.indeterminate = partial.indeterminate;
    if (typeof partial.disabled === 'boolean') input.disabled = partial.disabled;
  }
  syncCheckboxAria(input);
}