/**
 * tests/help_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/help/HelpView.ts in jsdom.
 * The legacy root `gm-help.js` is untouched during Phase 1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HelpView, HELP_DB } from '../src/modules/help/HelpView';

function boot() {
  document.body.innerHTML =
    '<button type="button" class="gm-help-btn" data-help-id="help-event-svs">?</button>' +
    '<button type="button" data-help-id="help-unknown">?</button>';
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HelpView', () => {
  it('keeps the full help catalog (31 entries)', () => {
    expect(Object.keys(HELP_DB).length).toBe(31);
    expect(HELP_DB['help-event-svs'].title).toBe('Server vs Server (SvS)');
  });

  it('init() wires the delegated [data-help-id] click and opens the popover', () => {
    const view = new HelpView();
    boot();
    view.init();

    document.querySelector('[data-help-id="help-event-svs"]').click();

    const popover = document.getElementById('gm-help-popover');
    expect(popover).toBeTruthy();
    expect(popover.classList.contains('gm-help-open')).toBe(true);
    expect(popover.querySelector('#gm-help-title').textContent).toBe('Server vs Server (SvS)');
    expect(popover.querySelector('#gm-help-body').innerHTML).toContain('Tracks participation');
    expect(popover.querySelector('#gm-help-icon').className).toContain('ph-sword');

    view.destroy();
  });

  it('does nothing for an unknown data-help-id', () => {
    const view = new HelpView();
    boot();
    view.init();

    document.querySelector('[data-help-id="help-unknown"]').click();
    expect(document.getElementById('gm-help-popover')).toBeNull();

    view.destroy();
  });

  it('closes on Escape and on backdrop click', () => {
    const view = new HelpView();
    boot();
    view.init();

    document.querySelector('[data-help-id="help-event-svs"]').click();
    const popover = document.getElementById('gm-help-popover');
    expect(popover.classList.contains('gm-help-open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.classList.contains('gm-help-open')).toBe(false);

    // re-open and close via backdrop
    document.querySelector('[data-help-id="help-event-svs"]').click();
    expect(popover.classList.contains('gm-help-open')).toBe(true);
    popover.querySelector('.gm-help-backdrop').click();
    expect(popover.classList.contains('gm-help-open')).toBe(false);

    view.destroy();
  });

  it('reuses a single popover across opens and destroy() removes it', () => {
    const view = new HelpView();
    boot();
    view.init();

    view.open('help-event-svs');
    view.open('help-stats');
    expect(document.querySelectorAll('#gm-help-popover').length).toBe(1);
    expect(document.getElementById('gm-help-title').textContent).toBe('Guild Statistics');

    view.destroy();
    expect(document.getElementById('gm-help-popover')).toBeNull();
  });
});
