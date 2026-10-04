/**
 * src/core/dom/style-refs.ts
 *
 * Computed styles for HTML built as strings, under a CSP with no
 * `'unsafe-inline'` in style-src (2026-10-04). The browser refuses a
 * `style="..."` attribute in parsed markup, but applying a style through the
 * CSSOM (`element.style`) is allowed. So a template asks for a reference
 * instead of writing the attribute:
 *
 *   '<span ' + styleAttr('color:' + meta.color + ';') + '>'
 *   // -> <span data-gm-style="gs12">
 *
 * and the declarations are applied, through the CSSOM, when the element enters
 * the document (one MutationObserver, installed at boot by startStyleRefs()).
 * Mutation callbacks run before the next paint, so nothing renders unstyled.
 *
 * Why this does not reopen what the CSP closes: the attribute carries an id,
 * never CSS. The declarations live in this module's memory, put there by the
 * app's own code. Injected markup can at most name a style the app already
 * defined; it cannot write one.
 *
 * Static styles do not belong here: they are u-* classes (utilities.css). This
 * is for values computed at render time -- a colour from a tier map, a width
 * from a percentage.
 */

const ATTR = 'data-gm-style';

/** css text -> id, and back. Bounded by the number of distinct style strings. */
const idByCss = new Map<string, string>();
const cssById = new Map<string, string>();

/** The reference for `css`; the same text always gets the same id. */
export function styleRef(css: string): string {
  const text = String(css).trim();
  let id = idByCss.get(text);
  if (!id) {
    id = 'gs' + idByCss.size;
    idByCss.set(text, id);
    cssById.set(id, text);
  }
  return id;
}

/** ` data-gm-style="<id>"`, ready to splice into a tag. */
export function styleAttr(css: string): string {
  return ' ' + ATTR + '="' + styleRef(css) + '"';
}

function applyTo(el: Element): void {
  const id = el.getAttribute(ATTR);
  if (!id) return;
  const css = cssById.get(id);
  // An id this module never issued is ignored: markup cannot bring its own CSS.
  if (css === undefined) return;
  const style = (el as HTMLElement).style;
  if (!style) return;
  // Through cssText, whole: copying property by property would lose a
  // shorthand that holds a var() -- `background: var(--bg-soft)` reads back as
  // empty longhands. Appended to what element.style already holds, so a
  // declaration set earlier is kept unless this one names the same property,
  // as with the old attribute.
  const existing = style.cssText.trim();
  style.cssText = existing ? existing.replace(/;?$/, '; ') + css : css;
  el.removeAttribute(ATTR);
}

/** Applies every pending reference inside `root` (and `root` itself) now. */
export function applyStyleRefs(root: ParentNode | Element): void {
  if ((root as Element).getAttribute) applyTo(root as Element);
  root.querySelectorAll('[' + ATTR + ']').forEach(applyTo);
}

let observer: MutationObserver | null = null;

/** Installs the observer on the whole document. Idempotent; call once at boot. */
export function startStyleRefs(): void {
  if (observer || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  applyStyleRefs(document);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType === 1) applyStyleRefs(n as Element);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/** Test hook. */
export function _resetStyleRefsForTesting(): void {
  observer?.disconnect();
  observer = null;
  idByCss.clear();
  cssById.clear();
}
