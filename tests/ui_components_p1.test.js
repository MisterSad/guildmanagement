/**
 * tests/ui_components_p1.test.js
 *
 * Priority-1 modular form components (Switch / Checkbox / Input) plus the
 * Guild Settings retrofit integrity contract:
 * - generated DOM structure, ARIA attributes, cva class propagation
 * - onChange event wiring
 * - index.html already adopts the gm-ui-* harness while keeping every
 *   native input id stable (backward compat with byId/setChecked/submit)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  renderSwitch,
  createSwitch,
  syncSwitch,
  switchRecipe
} from '../src/components/ui/Switch';
import {
  renderCheckbox,
  createCheckbox,
  setIndeterminate,
  syncCheckbox,
  checkboxRecipe
} from '../src/components/ui/Checkbox';
import {
  renderInput,
  createInput,
  applyInputError,
  inputField
} from '../src/components/ui/Input';

const rootDir = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

describe('Switch — rendered structure & ARIA', () => {
  it('exports a cva recipe with size/accent variants and defaults', () => {
    expect(switchRecipe({})).toContain('gm-ui-switch');
    expect(switchRecipe({})).toContain('gm-ui-switch-md');
    expect(switchRecipe({})).toContain('gm-ui-accent-default');
    expect(switchRecipe({ size: 'sm', accent: 'svs' })).toContain('gm-ui-switch-sm');
    expect(switchRecipe({ size: 'sm', accent: 'svs' })).toContain('gm-ui-accent-svs');
  });

  it('keeps the native checkbox id and exposes role="switch" + aria-checked', () => {
    const html = renderSwitch({ id: 'notify-svs-pvp', label: 'Enable Day 6', checked: true });
    expect(html).toContain('id="notify-svs-pvp"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('checked');
  });

  it('reflects unchecked and emits the accessible label + escaped description', () => {
    const html = renderSwitch({ id: 'notify-svs-won-prep', label: 'Won Day 1 to 5', description: 'Only if <b>won</b>' });
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain(' checked');
    expect(html).toContain('Won Day 1 to 5');
    expect(html).toContain('&lt;b&gt;won&lt;/b&gt;');
  });

  it('marks disabled switches with a disabled input + aria-disabled', () => {
    const html = renderSwitch({ id: 'notify-nope', label: 'x', disabled: true });
    expect(html).toContain('disabled');
    expect(html).toContain('aria-disabled="true"');
  });
});

describe('Switch — live element behavior', () => {
  let label;
  let input;
  let lastCall;

  beforeEach(() => {
    document.body.innerHTML = '';
    lastCall = null;
    label = createSwitch({
      id: 'notify-gvg-pvp',
      label: 'Enable Day 6',
      accent: 'gvg',
      onChange: (checked, el) => { lastCall = { checked, id: el.id }; }
    });
    document.body.appendChild(label);
    input = label.querySelector('.gm-ui-switch-input');
  });

  it('returns a label whose native input is findable by id', () => {
    expect(label).toBeInstanceOf(HTMLLabelElement);
    expect(document.getElementById('notify-gvg-pvp')).toBe(input);
  });

  it('fires onChange on click and keeps aria-checked in sync', () => {
    input.click();
    expect(lastCall.checked).toBe(true);
    expect(input.getAttribute('aria-checked')).toBe('true');
    input.click();
    expect(lastCall.checked).toBe(false);
    expect(input.getAttribute('aria-checked')).toBe('false');
  });

  it('syncSwitch applies imperative checked/disabled + ARIA', () => {
    syncSwitch(input, { checked: true, disabled: true });
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('aria-checked')).toBe('true');
    expect(input.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Checkbox — structure, indeterminate, events', () => {
  it('renders a native checkbox with id + aria-checked and cva classes', () => {
    const html = renderCheckbox({ id: 'roster-opt-in', label: 'Opt in', size: 'sm' });
    expect(html).toContain('id="roster-opt-in"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('gm-ui-checkbox-sm');
    expect(checkboxRecipe({ accent: 'danger' })).toContain('gm-ui-accent-danger');
  });

  it('setIndeterminate sets the DOM property and aria-checked="mixed"', () => {
    const labelEl = createCheckbox({ id: 'cb', label: 'All' });
    document.body.appendChild(labelEl);
    const input = labelEl.querySelector('.gm-ui-checkbox-input');
    setIndeterminate(input, true);
    expect(input.indeterminate).toBe(true);
    expect(input.getAttribute('aria-checked')).toBe('mixed');
    setIndeterminate(input, false);
    expect(input.getAttribute('aria-checked')).toBe('false');
  });

  it('fires onChange with checked and re-syncs ARIA on user click', () => {
    let called = null;
    const labelEl = createCheckbox({ id: 'cb2', label: 'All', onChange: (v) => { called = v; } });
    document.body.appendChild(labelEl);
    const input = labelEl.querySelector('.gm-ui-checkbox-input');
    input.click();
    expect(called).toBe(true);
    expect(input.getAttribute('aria-checked')).toBe('true');
  });

  it('syncCheckbox restores aria when toggled imperatively', () => {
    const labelEl = createCheckbox({ id: 'cb3', label: 'All' });
    document.body.appendChild(labelEl);
    const input = labelEl.querySelector('.gm-ui-checkbox-input');
    syncCheckbox(input, { checked: true });
    expect(input.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Input — field structure, errors, events', () => {
  it('renders a gm-ui-input wrapper + native field with passthrough attrs', () => {
    const html = renderInput({ id: 'coeff-svs', type: 'number', min: 0, max: 20, required: true });
    expect(html).toContain('gm-ui-input gm-ui-input-md');
    expect(html).toContain('id="coeff-svs"');
    expect(html).toContain('type="number"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="20"');
    expect(html).toContain('required');
  });

  it('renders the mono small variant and value', () => {
    const html = renderInput({ id: 'webhook-svs', type: 'url', size: 'sm', mono: true, value: 'https://x' });
    expect(html).toContain('gm-ui-input-sm');
    expect(html).toContain('gm-ui-input-mono');
    expect(html).toContain('value="https://x"');
  });

  it('renders an error state with aria-invalid and a role=alert message', () => {
    const html = renderInput({ id: 'role-id', error: 'Invalid role ID' });
    expect(html).toContain('gm-ui-input-invalid');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('gm-ui-input-error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Invalid role ID');
  });

  it('createInput returns a wrapper and fires onChange on input events', () => {
    let last = null;
    const wrapper = createInput({ id: 'discord-role-id-gvg', onChange: (v) => { last = v; } });
    document.body.appendChild(wrapper);
    const field = inputField(wrapper);
    field.value = '123456';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(last).toBe('123456');
  });

  it('applyInputError toggles the error state and message element', () => {
    const wrapper = createInput({ id: 'webhook-dtr' });
    document.body.appendChild(wrapper);
    const field = inputField(wrapper);
    applyInputError(field, 'Webhook invalid');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(wrapper.querySelector('.gm-ui-input-error')?.textContent).toBe('Webhook invalid');
    applyInputError(field, null);
    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(wrapper.querySelector('.gm-ui-input-error')).toBeNull();
  });
});

describe('Guild Settings retrofit — index.html integrity contract', () => {
  const html = read('index.html');
  const styles = read('styles.css');

  const NOTIFY_IDS = [
    'notify-armsrace-creation', 'notify-armsrace-30', 'notify-armsrace-5', 'notify-armsrace-start',
    'notify-dtr-creation', 'notify-dtr-30', 'notify-dtr-5', 'notify-dtr-start',
    'notify-shadowfront-creation', 'notify-shadowfront-30', 'notify-shadowfront-5', 'notify-shadowfront-start',
    'notify-calamity-10',
    'notify-gvg-daily-tasks', 'notify-gvg-pvp',
    'notify-svs-pvp', 'notify-svs-garrison', 'notify-svs-won-prep'
  ];

  it('keeps every notify-* id as a gm-ui-switch native input (backward compat)', () => {
    NOTIFY_IDS.forEach((id) => {
      expect(html, `missing switch input for ${id}`).toMatch(
        new RegExp('<input type="checkbox" id="' + id + '" class="gm-ui-switch-input"')
      );
    });
  });

  it('exposes role="switch" + coherent aria-checked on every notify switch', () => {
    const re = /<input type="checkbox" id="(notify-[\w-]+)" class="gm-ui-switch-input"( checked)? role="switch" aria-checked="(true|false)">/g;
    const found = [...html.matchAll(re)].map((m) => m[1]);
    NOTIFY_IDS.forEach((id) => expect(found, `no switch-aria match for ${id}`).toContain(id));
    [...html.matchAll(re)].forEach((m) => {
      const hasCheckedAttr = m[2] !== undefined;
      expect(hasCheckedAttr, `aria-checked mismatch on ${m[1]}`).toBe(m[3] === 'true');
    });
  });

  it('wraps coeff/webhook/role fields as gm-ui-input-field with stable ids', () => {
    ['coeff-svs', 'coeff-gvg', 'coeff-shadowfront', 'coeff-dtr', 'coeff-armsrace',
      'webhook-armsrace', 'webhook-dtr', 'webhook-shadowfront', 'webhook-calamity',
      'webhook-gvg', 'webhook-svs',
      'discord-role-id', 'discord-role-id-armsrace', 'discord-role-id-dtr',
      'discord-role-id-shadowfront', 'discord-role-id-shadowfront-squad2',
      'discord-role-id-calamity', 'discord-role-id-gvg', 'discord-role-id-svs',
      'guild-server-number-setting', 'guild-tag-setting', 'discord-verification-channel-id'
    ].forEach((id) => {
      expect(html, `missing gm-ui-input-field for ${id}`).toMatch(
        new RegExp('id="' + id + '" class="gm-ui-input-field"')
      );
    });
  });

  it('styles.css ships the gm-ui primitives consuming theme.css variables', () => {
    ['.gm-ui-switch-track', '.gm-ui-switch-thumb', '.gm-ui-checkbox-box',
      '.gm-ui-input-field', '.gm-ui-accent-svs', '.gm-ui-accent-gvg',
      '.gm-ui-accent-glory', '.gm-ui-accent-danger'
    ].forEach((sel) => expect(styles, `missing ${sel} in styles.css`).toContain(sel));
    expect(styles).toMatch(/\.gm-ui-switch-input:focus-visible ~ \.gm-ui-switch-track \{[^}]*var\(--ring\)/);
    expect(styles).toMatch(/\.gm-ui-input-field:focus-visible \{[^}]*var\(--ring\)/);
  });
});