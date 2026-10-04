/**
 * tests/dialog_adopt.test.js
 *
 * adoptDialog (src/components/ui/Dialog.ts, M5): a hand-built overlay becomes
 * an accessible modal without changing its markup, and every dialog shares
 * one stack so the innermost owns the keyboard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adoptDialog, openDialog, closeDialog, isDialogOpen } from '../src/components/ui/Dialog';

function overlay(id, { heading = 'Edit member' } = {}) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'gm-modal-overlay';
  el.setAttribute('role', 'dialog');
  el.innerHTML = '<div class="gm-modal-card">' + (heading ? '<h3>' + heading + '</h3>' : '') +
    '<input id="' + id + '-a"><button id="' + id + '-b">OK</button></div>';
  document.body.appendChild(el);
  return el;
}
const key = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"><button id="opener">open</button></div>';
});

describe('adoptDialog', () => {
  it('puts the dialog role and its label on the card, not the overlay', () => {
    const el = overlay('o1');
    adoptDialog(el);
    const card = el.querySelector('.gm-modal-card');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(card.getAttribute('aria-labelledby')).textContent).toBe('Edit member');
    expect(el.hasAttribute('role')).toBe(false);
  });

  it('falls back to aria-label when there is no heading', () => {
    const el = overlay('o2', { heading: '' });
    adoptDialog(el, { label: 'Screenshot' });
    expect(el.querySelector('.gm-modal-card').getAttribute('aria-label')).toBe('Screenshot');
  });

  it('moves focus in, hides the page, and gives both back when the overlay is removed', async () => {
    document.getElementById('opener').focus();
    const el = overlay('o3');
    adoptDialog(el);
    expect(document.activeElement.id).toBe('o3-a');
    expect(document.getElementById('app').getAttribute('aria-hidden')).toBe('true');
    expect(isDialogOpen()).toBe(true);
    el.remove();
    await flush();
    expect(isDialogOpen()).toBe(false);
    expect(document.getElementById('app').hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement.id).toBe('opener');
  });

  it('runs onEscape, and ignores Escape when there is none', () => {
    const onEscape = vi.fn();
    const release = adoptDialog(overlay('o4'), { onEscape });
    key('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    release();
    const blocking = adoptDialog(overlay('o5'));
    expect(() => key('Escape')).not.toThrow();
    blocking();
  });

  it('wraps Tab inside the card', () => {
    const release = adoptDialog(overlay('o6'));
    document.getElementById('o6-b').focus();
    key('Tab');
    expect(document.activeElement.id).toBe('o6-a');
    key('Tab', { shiftKey: true });
    expect(document.activeElement.id).toBe('o6-b');
    release();
  });

  it('lets only the innermost dialog handle the keyboard', async () => {
    const outerEscape = vi.fn();
    const releaseOuter = adoptDialog(overlay('outer'), { onEscape: outerEscape });
    const onCancel = vi.fn();
    const inner = openDialog({ title: 'Sure?', body: '<p>x</p>', cancelLabel: 'No', confirmLabel: 'Yes', onCancel });

    key('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outerEscape).not.toHaveBeenCalled();
    expect(inner.isConnected).toBe(false);
    // The page stays hidden while the outer dialog is still open.
    expect(document.getElementById('app').getAttribute('aria-hidden')).toBe('true');

    key('Escape');
    expect(outerEscape).toHaveBeenCalledTimes(1);
    releaseOuter();
  });

  it('releases an openDialog root that other code removed', async () => {
    const d = openDialog({ title: 'T', body: '<p>b</p>' });
    expect(isDialogOpen()).toBe(true);
    d.remove();
    await flush();
    expect(isDialogOpen()).toBe(false);
    closeDialog(d); // idempotent
  });
});

describe('every hand-built overlay is adopted', () => {
  it('pairs each .gm-modal-overlay construction with adoptDialog', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const walk = (d, o = []) => {
      for (const e of fs.readdirSync(d)) {
        const p = path.join(d, e);
        if (fs.statSync(p).isDirectory()) walk(p, o); else if (p.endsWith('.ts')) o.push(p);
      }
      return o;
    };
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders = [];
    let builders = 0;
    for (const file of walk(path.resolve(__dirname, '..', 'src'))) {
      if (file.endsWith(path.join('components', 'ui', 'Dialog.ts'))) continue;
      const code = strip(fs.readFileSync(file, 'utf8'));
      const built = (code.match(/className = 'gm-modal-overlay|class="gm-modal-overlay/g) || []).length;
      if (!built) continue;
      builders += built;
      const adopted = (code.match(/adoptDialog\(/g) || []).length;
      if (adopted < built) offenders.push(`${path.relative(process.cwd(), file)}: ${built} built, ${adopted} adopted`);
    }
    expect(builders).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
