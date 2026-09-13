/**
 * tests/ui_components_p3.test.js
 *
 * Priority-3 modular components (Dialog / Tooltip) + retrofit contracts:
 * - Dialog lifecycle: open, ARIA attributes, Escape / backdrop close, focus
 *   trap, confirm/cancel hooks, tone/size cva variants, closing cleanup.
 * - Tooltip: singleton node + role, keyboard (focus/blur) and mouse
 *   (mouseenter/leave) triggers, declarative [data-tooltip] init.
 * - HistoryView session modal now rides the Dialog component while keeping
 *   the legacy #history-modal / #history-modal-delete surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  openDialog,
  closeDialog,
  dialogCard,
  dialogRecipe
} from '../src/components/ui/Dialog';
import {
  showTooltip,
  hideTooltip,
  bindTooltip,
  initTooltips
} from '../src/components/ui/Tooltip';
import { HistoryView } from '../src/modules/history/views/HistoryView';

/* ─── Dialog — cva recipe & variants ──────────────────────────────────── */
describe('Dialog — cva recipe, tone & size variants', () => {
  it('exports a cva recipe with default tone/size', () => {
    expect(dialogRecipe({})).toContain('gm-ui-dialog-md');
    expect(dialogRecipe({})).toContain('gm-ui-dialog-default');
  });

  it('resolves tone and size variants', () => {
    expect(dialogRecipe({ tone: 'danger', size: 'lg' })).toContain('gm-ui-dialog-danger');
    expect(dialogRecipe({ tone: 'danger', size: 'lg' })).toContain('gm-ui-dialog-lg');
    expect(dialogRecipe({ size: 'full' })).toContain('gm-ui-dialog-full');
    expect(dialogRecipe({ size: 'sm' })).toContain('gm-ui-dialog-sm');
  });
});

/* ─── Dialog — lifecycle & accessibility ───────────────────────────────── */
describe('Dialog — lifecycle, ARIA & close paths', () => {
  let dialog;

  afterEach(() => {
    closeDialog(dialog);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('openDialog mounts the card with role=dialog, aria-modal and labelledby', () => {
    dialog = openDialog({ id: 'dlg', title: 'Session detail' });
    const root = document.getElementById('dlg');
    expect(root).toBe(dialog);
    const card = dialogCard(dialog);
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    const titleId = card.getAttribute('aria-labelledby');
    expect(card.querySelector('#' + titleId + '.gm-ui-dialog-title')?.textContent).toContain('Session detail');
  });

  it('links aria-describedby + body id when provided', () => {
    dialog = openDialog({ id: 'dlg2', title: 'T', describedBy: 'dlg2-hint', bodyId: 'dlg2-hint', body: '<p>hint</p>' });
    const card = dialogCard(dialog);
    expect(card.getAttribute('aria-describedby')).toBe('dlg2-hint');
    expect(card.querySelector('#dlg2-hint')).toBeTruthy();
  });

  it('renders header icon + subtitle and danger tone on the card', () => {
    dialog = openDialog({ id: 'dlg3', title: 'Delete session', iconClass: 'ph-trash', subtitle: 'SvS · W32', tone: 'danger' });
    const card = dialogCard(dialog);
    expect(card.className).toContain('gm-ui-dialog-danger');
    expect(card.querySelector('.gm-ui-dialog-subtitle')?.textContent).toContain('SvS');
    expect(card.querySelector('.gm-ui-dialog-heading i.ph-fill')).toBeTruthy();
  });

  it('confirm button fires onConfirm (awaited) then closes the dialog', async () => {
    let called = 0;
    dialog = openDialog({
      id: 'dlg4', title: 'T', confirmLabel: 'Save',
      onConfirm: () => { called++; }
    });
    const stale = document.getElementById('dlg4');
    const confirmBtn = dialogCard(dialog).querySelector('.gm-ui-dialog-confirm');
    confirmBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(called).toBe(1);
    expect(document.getElementById('dlg4')).toBeNull();
    expect(stale).toBe(dialog);
    dialog = null;
  });

  it('cancel button fires onCancel and closes', () => {
    let cancelled = 0;
    dialog = openDialog({ id: 'dlg5', title: 'T', cancelLabel: 'Cancel', onCancel: () => { cancelled++; } });
    dialogCard(dialog).querySelector('.gm-ui-dialog-cancel').click();
    expect(cancelled).toBe(1);
    expect(document.getElementById('dlg5')).toBeNull();
    dialog = null;
  });

  it('closes on Escape and invokes onCancel', () => {
    let cancelled = 0;
    dialog = openDialog({ id: 'dlg6', title: 'T', onCancel: () => { cancelled++; } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelled).toBe(1);
    expect(document.getElementById('dlg6')).toBeNull();
    dialog = null;
  });

  it('closes on backdrop click (target is the root overlay)', () => {
    let cancelled = 0;
    dialog = openDialog({ id: 'dlg7', title: 'T', onCancel: () => { cancelled++; } });
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cancelled).toBe(1);
    expect(document.getElementById('dlg7')).toBeNull();
    dialog = null;
  });

  it('traps Tab focus inside the card (wrap both directions)', () => {
    dialog = openDialog({
      id: 'dlg8', title: 'T',
      body: '<button type="button" id="a">A</button><button type="button" id="b">B</button>',
      noFooter: true
    });
    const card = dialogCard(dialog);
    const a = card.querySelector('#a');
    const b = card.querySelector('#b');
    const headerClose = card.querySelector('.gm-ui-dialog-header-close');
    // Initial focus is the header close (first focusable).
    expect(document.activeElement).toBe(headerClose);
    // Shift+Tab from the first item wraps to the last focusable.
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(b);
    // Tab from the last item wraps to the first.
    b.focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(headerClose);
    void a;
  });

  it('accepts an HTMLElement body node', () => {
    const node = document.createElement('div');
    node.id = 'custom-body';
    node.textContent = 'custom';
    dialog = openDialog({ id: 'dlg9', title: 'T', body: node });
    const card = dialogCard(dialog);
    expect(card.querySelector('#custom-body')?.textContent).toBe('custom');
  });

  it('closeDialog removes the root and is idempotent', () => {
    dialog = openDialog({ id: 'dlg10', title: 'T' });
    closeDialog(dialog);
    expect(document.getElementById('dlg10')).toBeNull();
    closeDialog(dialog);
    dialog = null;
  });
});

/* ─── Tooltip — singleton node, triggers, declarative init ─────────────── */
describe('Tooltip — node, triggers & declarative init', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('showTooltip creates the singleton role=tooltip node with the text', () => {
    const host = document.createElement('button');
    showTooltip(host, { text: 'Score entered per day', position: 'top' });
    const tip = document.getElementById('gm-ui-tooltip-root');
    expect(tip).toBeTruthy();
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toBe('Score entered per day');
    expect(tip.className).toContain('gm-ui-tooltip-visible');
  });

  it('hideTooltip clears the pending timer and hides the node', async () => {
    const host = document.createElement('button');
    bindTooltip(host, { text: 'tip', delay: 0 });
    document.body.appendChild(host);
    host.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((r) => setTimeout(r, 10));
    const tip = document.getElementById('gm-ui-tooltip-root');
    expect(tip?.className).toContain('gm-ui-tooltip-visible');
    hideTooltip(host);
    expect(tip?.className).not.toContain('gm-ui-tooltip-visible');
  });

  it('bindTooltip wires keyboard focus/blur with delay', async () => {
    const host = document.createElement('button');
    bindTooltip(host, { text: 'keyboard tip', delay: 0 });
    document.body.appendChild(host);
    expect(host.getAttribute('aria-describedby')).toBe('gm-ui-tooltip-root');
    host.dispatchEvent(new FocusEvent('focusin'));
    await new Promise((r) => setTimeout(r, 10));
    const tip = document.getElementById('gm-ui-tooltip-root');
    expect(tip?.textContent).toBe('keyboard tip');
    expect(tip?.className).toContain('gm-ui-tooltip-visible');
    host.dispatchEvent(new FocusEvent('focusout'));
    expect(tip?.className).not.toContain('gm-ui-tooltip-visible');
  });

  it('bindTooltip wires mouseenter/mouseleave', async () => {
    const host = document.createElement('button');
    bindTooltip(host, { text: 'mouse tip', delay: 0 });
    document.body.appendChild(host);
    host.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((r) => setTimeout(r, 10));
    const tip = document.getElementById('gm-ui-tooltip-root');
    expect(tip?.textContent).toBe('mouse tip');
    expect(tip?.className).toContain('gm-ui-tooltip-visible');
    host.dispatchEvent(new MouseEvent('mouseleave'));
    expect(tip?.className).not.toContain('gm-ui-tooltip-visible');
  });

  it('initTooltips binds declarative [data-tooltip] elements once', () => {
    const el = document.createElement('button');
    el.setAttribute('data-tooltip', 'hint');
    el.setAttribute('data-tooltip-pos', 'top');
    document.body.appendChild(el);
    initTooltips(document);
    expect(el.getAttribute('data-gm-tooltip-bound')).toBe('1');
    expect(el.getAttribute('aria-describedby')).toBe('gm-ui-tooltip-root');
    initTooltips(document);
    expect(el.getAttribute('data-gm-tooltip-bound')).toBe('1');
  });
});

/* ─── HistoryView — session modal rides the Dialog component ───────────── */
const SESSIONS = [
  { event_name: 'SvS', session_id: 'SVS-2026-W32', week_start: '2026-08-03', participants: 10, participated_count: 8, total_score: 1000 }
];
const PARTICIPANT_ROWS = [
  { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'SvS', session_id: 'SVS-2026-W32', week_start: '2026-08-03', participated: 1, score: 100, score_prep: 10, score_pvp: 5, late: false, excused: false, sub_present: false, appointed: false },
  { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'SvS', session_id: 'SVS-2026-W32', week_start: '2026-08-03', participated: 0, score: 0, score_prep: 0, score_pvp: 0, late: false, excused: false, sub_present: false, appointed: false }
];

function chained(value, updateMock) {
  const filters = [];
  const apply = () => {
    let res = (value || []).slice();
    filters.forEach((f) => { res = res.filter(f); });
    return res;
  };
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    is: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    in: (field, list) => { filters.push((r) => list.indexOf(r[field]) !== -1); return chain; },
    update: (payload) => { updateMock(payload); return chain; },
    delete: () => chain,
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve)
  };
  return chain;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('HistoryView — Dialog retrofit contract', () => {
  let updateMock;

  beforeEach(() => {
    document.body.innerHTML = '<div id="event-history"><div class="history-area"></div></div>';
    updateMock = vi.fn(() => chained([]));
    window.GM = {
      t: (k) => k,
      escapeHTML: (s) => String(s ?? ''),
      formatNumber: (n) => String(n ?? ''),
      avatarInit: (s) => String(s || '').slice(0, 1).toUpperCase(),
      attachNumberFormatter: vi.fn(),
      parseNumber: (v) => parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0,
      getActiveGuild: () => 'ALPHA',
      buildEventSessionId: (ev, ws) => 'GLORY-' + ws,
      getEventIcon: () => 'ph-swords',
      getEventTheme: () => 'gm-task-card-dark',
      formatWeek: (w) => w,
      roleFromStorage: () => 'guild_admin',
      showToast: vi.fn(),
      cache: { isFresh: () => false, markFresh: vi.fn() },
      db: {
        rpc: vi.fn(async () => ({ data: JSON.parse(JSON.stringify(SESSIONS)), error: null })),
        from: (table) => chained(table === 'event_participants' ? PARTICIPANT_ROWS : [], updateMock)
      }
    };
    window.showConfirm = vi.fn();
  });

  afterEach(() => {
    delete window.GM;
    delete window.showConfirm;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens the war session modal on Dialog with ARIA + tbody rows intact', async () => {
    const view = new HistoryView();
    await view.load();
    document.querySelector('.gm-history-card[data-event="SvS"]').click();
    await tick();

    const modal = document.getElementById('history-modal');
    expect(modal).toBeTruthy();
    const card = modal.querySelector('.gm-ui-dialog-wrap');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.getAttribute('aria-labelledby')).toBeTruthy();
    expect(modal.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('closes the session modal on Escape', async () => {
    const view = new HistoryView();
    await view.load();
    document.querySelector('.gm-history-card[data-event="SvS"]').click();
    await tick();
    expect(document.getElementById('history-modal')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('history-modal')).toBeNull();
  });

  it('keeps the destructive delete flow behind legacy confirmation', async () => {
    const view = new HistoryView();
    await view.load();
    document.querySelector('.gm-history-card[data-event="SvS"]').click();
    await tick();
    document.getElementById('history-modal-delete').click();
    expect(window.showConfirm).toHaveBeenCalledWith('confirm_delete_session_title', expect.any(String), expect.any(Function));
  });
});