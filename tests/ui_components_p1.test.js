/**
 * Guild Settings markup contract.
 *
 * This file used to also unit-test the Switch, Checkbox and Input primitives
 * from the shadcn-like design system batch. Those three modules (and Table, in
 * ui_components_p2) were deleted: they were imported by nothing but these tests.
 * Their `gm-ui-*` CSS classes ARE in use -- but by hand-written markup in
 * index.html, HistoryView and EventsView, which duplicated what the primitives
 * generated. The stylesheets therefore stay; only the unused generators went.
 */

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
import { describe, it, expect } from 'vitest';
import { appHtml } from './helpers/app-html.js';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

describe('Guild Settings retrofit — index.html integrity contract', () => {
  const html = appHtml();
  const styles = read('styles.css');

  const NOTIFY_IDS = [
    'notify-armsrace-creation',
    'notify-armsrace-30',
    'notify-armsrace-5',
    'notify-armsrace-start',
    'notify-dtr-creation',
    'notify-dtr-30',
    'notify-dtr-5',
    'notify-dtr-start',
    'notify-shadowfront-creation',
    'notify-shadowfront-30',
    'notify-shadowfront-5',
    'notify-shadowfront-start',
    'notify-calamity-10',
    'notify-gvg-daily-tasks',
    'notify-gvg-pvp',
    'notify-svs-pvp',
    'notify-svs-garrison',
    'notify-svs-won-prep',
  ];

  it('keeps every notify-* id as a gm-ui-switch native input (backward compat)', () => {
    NOTIFY_IDS.forEach((id) => {
      expect(html, `missing switch input for ${id}`).toMatch(
        new RegExp('<input type="checkbox" id="' + id + '" class="gm-ui-switch-input"')
      );
    });
  });

  it('exposes role="switch" + coherent aria-checked on every notify switch', () => {
    const re =
      /<input type="checkbox" id="(notify-[\w-]+)" class="gm-ui-switch-input"( checked)? role="switch" aria-checked="(true|false)">/g;
    const found = [...html.matchAll(re)].map((m) => m[1]);
    NOTIFY_IDS.forEach((id) => expect(found, `no switch-aria match for ${id}`).toContain(id));
    [...html.matchAll(re)].forEach((m) => {
      const hasCheckedAttr = m[2] !== undefined;
      expect(hasCheckedAttr, `aria-checked mismatch on ${m[1]}`).toBe(m[3] === 'true');
    });
  });

  it('wraps coeff/webhook/role fields as gm-ui-input-field with stable ids', () => {
    [
      'coeff-svs',
      'coeff-gvg',
      'coeff-shadowfront',
      'coeff-dtr',
      'coeff-armsrace',
      'webhook-armsrace',
      'webhook-dtr',
      'webhook-shadowfront',
      'webhook-calamity',
      'webhook-gvg',
      'webhook-svs',
      'discord-role-id',
      'discord-role-id-armsrace',
      'discord-role-id-dtr',
      'discord-role-id-shadowfront',
      'discord-role-id-shadowfront-squad2',
      'discord-role-id-calamity',
      'discord-role-id-gvg',
      'discord-role-id-svs',
      'guild-server-number-setting',
      'guild-tag-setting',
      'discord-verification-channel-id',
    ].forEach((id) => {
      expect(html, `missing gm-ui-input-field for ${id}`).toMatch(
        new RegExp('id="' + id + '"(?: aria-label="[^"]*")? class="gm-ui-input-field[ "]')
      );
    });
  });

  it('styles.css ships the gm-ui primitives consuming theme.css variables', () => {
    [
      '.gm-ui-switch-track',
      '.gm-ui-switch-thumb',
      '.gm-ui-checkbox-box',
      '.gm-ui-input-field',
      '.gm-ui-accent-svs',
      '.gm-ui-accent-gvg',
      '.gm-ui-accent-glory',
      '.gm-ui-accent-danger',
    ].forEach((sel) => expect(styles, `missing ${sel} in styles.css`).toContain(sel));
    expect(styles).toMatch(/\.gm-ui-switch-input:focus-visible ~ \.gm-ui-switch-track \{[^}]*var\(--ring\)/);
    expect(styles).toMatch(/\.gm-ui-input-field:focus-visible \{[^}]*var\(--ring\)/);
  });
});
