/**
 * tests/style_refs.test.js
 *
 * src/core/dom/style-refs.ts: computed styles for string-built markup under a
 * CSP that refuses inline style attributes. The markup carries a reference;
 * the CSS lives in the module and is applied through the CSSOM on insertion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  styleRef,
  styleAttr,
  applyStyleRefs,
  startStyleRefs,
  _resetStyleRefsForTesting,
} from '../src/core/dom/style-refs';

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetStyleRefsForTesting();
  document.body.innerHTML = '';
});

describe('style references', () => {
  it('gives the same text the same id, and different text a different one', () => {
    expect(styleRef('color: red;')).toBe(styleRef('  color: red;  '));
    expect(styleRef('color: red;')).not.toBe(styleRef('color: blue;'));
    expect(styleAttr('width: 40%;')).toMatch(/^ data-gm-style="gs\d+"$/);
  });

  it('applies the declarations when the markup enters the document, and drops the attribute', async () => {
    startStyleRefs();
    document.body.innerHTML = '<div id="bar"' + styleAttr('width: 42%; background: rgb(1, 2, 3);') + '></div>';
    await tick();
    const bar = document.getElementById('bar');
    expect(bar.style.width).toBe('42%');
    expect(bar.style.background).toContain('rgb(1, 2, 3)');
    expect(bar.hasAttribute('data-gm-style')).toBe(false);
  });

  it('reaches references nested anywhere in an inserted subtree', async () => {
    startStyleRefs();
    const host = document.createElement('section');
    host.innerHTML = '<ul><li><span id="chip"' + styleAttr('color: rgb(9, 9, 9);') + '>x</span></li></ul>';
    document.body.appendChild(host);
    await tick();
    expect(document.getElementById('chip').style.color).toBe('rgb(9, 9, 9)');
  });

  it('ignores an id it never issued: markup cannot bring its own CSS', () => {
    document.body.innerHTML = '<div id="x" data-gm-style="gs999" ></div><div id="y" data-gm-style="color:red"></div>';
    applyStyleRefs(document);
    expect(document.getElementById('x').style.cssText).toBe('');
    expect(document.getElementById('y').style.cssText).toBe('');
  });

  it('keeps a style already set through element.style unless the reference names the same property', () => {
    document.body.innerHTML = '<div id="z"' + styleAttr('color: rgb(0, 0, 255);') + '></div>';
    const z = document.getElementById('z');
    z.style.display = 'flex';
    applyStyleRefs(document);
    expect(z.style.display).toBe('flex');
    expect(z.style.color).toBe('rgb(0, 0, 255)');
  });

  it('keeps a shorthand that uses a custom property', () => {
    document.body.innerHTML =
      '<div id="v"' + styleAttr('background: var(--bg-soft); border: 1px solid var(--border-soft);') + '></div>';
    applyStyleRefs(document);
    const v = document.getElementById('v');
    expect(v.style.background).toBe('var(--bg-soft)');
    expect(v.style.border).toBe('1px solid var(--border-soft)');
  });
});
