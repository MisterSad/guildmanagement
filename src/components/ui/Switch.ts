/**
 * src/components/ui/Switch.ts
 *
 * Accessible toggle switch (shadcn/ui philosophy).
 *
 * Backward-compatibility contract: the component keeps a NATIVE checkbox
 * input carrying the caller's id, so imperative legacy reads
 * (byId(id).checked, setChecked(), onGuildSettingsSubmit) keep working
 * unchanged. ARIA: role="switch" + aria-checked, mirrored by CSS-driven
 * track/thumb state. Hit-slop is a guaranteed 44x44px targeting zone.
 */

import { cva } from '../../core/utils/cva';
import { cn } from '../../core/utils/cn';
import { escapeHTML } from '../../core/utils/text';
import type { UiSize } from './types';

export type SwitchAccent = 'default' | 'svs' | 'gvg' | 'glory' | 'danger';

export interface SwitchProps {
  /** Native input id — MUST be stable for legacy imperative reads. */
  id: string;
  /** Accessible label (already i18n-resolved by the caller). */
  label: string;
  checked?: boolean;
  disabled?: boolean;
  accent?: SwitchAccent;
  size?: UiSize;
  /** Helper line rendered under the label. */
  description?: string;
  className?: string;
  onChange?: (checked: boolean, input: HTMLInputElement) => void;
}

export const switchRecipe = cva('gm-ui-switch', {
  variants: {
    size: { sm: 'gm-ui-switch-sm', md: 'gm-ui-switch-md' },
    accent: {
      default: 'gm-ui-accent-default',
      svs: 'gm-ui-accent-svs',
      gvg: 'gm-ui-accent-gvg',
      glory: 'gm-ui-accent-glory',
      danger: 'gm-ui-accent-danger'
    }
  },
  defaultVariants: { size: 'md', accent: 'default' }
});

export function switchClassList(props: SwitchProps): string {
  return switchRecipe({ size: props.size, accent: props.accent });
}

export function renderSwitch(props: SwitchProps): string {
  const id = escapeHTML(props.id);
  const checked = props.checked === true;
  const disabled = props.disabled === true;
  const label = escapeHTML(props.label);
  const description = props.description ? escapeHTML(props.description) : '';
  const cls = cn(switchClassList(props), props.className);
  const descHtml = description ? '<span class="gm-ui-switch-desc">' + description + '</span>' : '';

  return (
    '<label class="' + cn(cls) + '">' +
      '<span class="gm-ui-switch-hit">' +
        '<input type="checkbox" class="gm-ui-switch-input" id="' + id + '"' +
          (checked ? ' checked' : '') +
          (disabled ? ' disabled' : '') +
          ' role="switch" aria-checked="' + (checked ? 'true' : 'false') + '"' +
          (disabled ? ' aria-disabled="true"' : '') +
          '>' +
        '<span class="gm-ui-switch-track"><span class="gm-ui-switch-thumb"></span></span>' +
      '</span>' +
      '<span class="gm-ui-switch-label">' +
        '<span class="gm-ui-switch-text">' + label + '</span>' +
        descHtml +
      '</span>' +
    '</label>'
  );
}

function syncSwitchAria(input: HTMLInputElement): void {
  input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
  if (input.disabled) input.setAttribute('aria-disabled', 'true');
  else input.removeAttribute('aria-disabled');
}

/** Builds a live switch element (label) with change wiring. */
export function createSwitch(props: SwitchProps): HTMLLabelElement {
  const host = document.createElement('span');
  host.innerHTML = renderSwitch(props);
  const label = host.firstElementChild as HTMLLabelElement;
  const input = label.querySelector<HTMLInputElement>('.gm-ui-switch-input') as HTMLInputElement;
  input.addEventListener('change', () => {
    syncSwitchAria(input);
    props.onChange?.(input.checked, input);
  });
  return label;
}

/** Imperative state sync for a switch's native input (setChecked-style). */
export function syncSwitch(input: HTMLInputElement | null, partial: Pick<SwitchProps, 'checked' | 'disabled'> | undefined): void {
  if (!input) return;
  if (partial) {
    if (typeof partial.checked === 'boolean') input.checked = partial.checked;
    if (typeof partial.disabled === 'boolean') input.disabled = partial.disabled;
  }
  syncSwitchAria(input);
}