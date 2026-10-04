/**
 * tests/webhook_field_placeholder.test.js
 *
 * A webhook field never shows its URL (ARC-04): when one is set, the input is
 * left empty and says so. The text must fit the card's input -- the long form
 * was cut off mid-word -- with the full sentence as the tooltip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/integrations/discord', async (importOriginal) => ({
  ...(await importOriginal()),
  configuredWebhooks: vi.fn(async () => ['webhook_gvg']),
}));

import { loadGuildSettings } from '../src/modules/app/admin/guild-requests.controller';

const field = (id) =>
  `<span class="gm-ui-input"><input id="${id}" class="gm-ui-input-field" placeholder="Webhook URL"></span>`;

beforeEach(() => {
  document.body.innerHTML =
    '<form id="guild-settings-form"><div>' +
    field('webhook-gvg') +
    '</div><div>' +
    field('webhook-svs') +
    '</div></form>';
});

describe('webhook fields', () => {
  it('a set webhook says so in a placeholder short enough to read, with the full sentence on hover', async () => {
    await loadGuildSettings();
    const gvg = document.getElementById('webhook-gvg');
    expect(gvg.value).toBe('');
    expect(gvg.placeholder).toBe('Set — paste a URL to replace');
    expect(gvg.placeholder.length).toBeLessThanOrEqual(30);
    expect(gvg.title).toBe('A webhook is set. Paste a new URL to replace it.');
  });

  it('an unset webhook keeps its own placeholder and no tooltip', async () => {
    await loadGuildSettings();
    const svs = document.getElementById('webhook-svs');
    expect(svs.placeholder).toBe('Webhook URL');
    expect(svs.title).toBe('');
  });
});
