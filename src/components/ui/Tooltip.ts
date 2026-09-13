/**
 * src/components/ui/Tooltip.ts
 *
 * Lightweight declarative tooltip (shadcn/ui philosophy):
 *   - Declarative: any element carrying data-tooltip="text" is bound by
 *     initTooltips() (plus optional data-tooltip-pos="top|bottom" and
 *     data-tooltip-delay ms).
 *   - Programmatic: bindTooltip(el, { text, position, delay }).
 *   - Keyboard accessible: shows on focusin/focus, hides on blur/focusout,
 *     alongside mouseenter/mouseleave. The host gets aria-describedby.
 *
 * A single singleton tooltip node (#gm-ui-tooltip-root) is positioned over the
 * host using fixed coordinates — tokens (--popover, --radius, --border) drive
 * the visuals defined in styles.css.
 */

import { escapeHTML } from '../../core/utils/text';

export interface TooltipOptions {
  text: string;
  position?: 'top' | 'bottom';
  /** Show delay in ms (default 150). */
  delay?: number;
  /** Extra class on the tooltip node. */
  className?: string;
}

const TOOLTIP_ID = 'gm-ui-tooltip-root';
const DELAY_DEFAULT = 150;

const pending: WeakMap<HTMLElement, ReturnType<typeof setTimeout>> = new WeakMap();

function getTooltipNode(): HTMLDivElement {
  let tip = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null;
  if (!tip) {
    tip = document.createElement('div');
    tip.id = TOOLTIP_ID;
    tip.className = 'gm-ui-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.style.position = 'fixed';
    tip.style.visibility = 'hidden';
    document.body.appendChild(tip);
  }
  return tip;
}

export function showTooltip(host: HTMLElement, opts: TooltipOptions): void {
  const tip = getTooltipNode();
  tip.textContent = '';
  tip.append(document.createTextNode(opts.text));
  tip.className = 'gm-ui-tooltip' + (opts.className ? ' ' + opts.className : '');
  tip.style.maxWidth = '260px';
  tip.style.visibility = 'hidden';

  const rect = host.getBoundingClientRect();
  const isTop = opts.position !== 'bottom';
  // Measure then anchor.
  const tipRect = tip.getBoundingClientRect();
  const gap = 8;
  const left = Math.max(4, Math.round(rect.left + rect.width / 2 - tipRect.width / 2));
  const top = isTop
    ? Math.max(4, Math.round(rect.top - tipRect.height - gap))
    : Math.round(rect.bottom + gap);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  tip.style.zIndex = '3000';

  // Force reflow then fade in.
  void tip.offsetHeight;
  tip.style.visibility = 'visible';
  tip.classList.add('gm-ui-tooltip-visible');
  void tip.offsetHeight;
}

export function hideTooltip(host: HTMLElement | null): void {
  const t = pending.get(host as HTMLElement);
  if (t) {
    clearTimeout(t);
    pending.delete(host as HTMLElement);
  }
  const tip = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null;
  if (tip) {
    tip.classList.remove('gm-ui-tooltip-visible');
    tip.style.visibility = 'hidden';
  }
}

/** Binds a host element to the singleton tooltip (mouse + keyboard). */
export function bindTooltip(el: HTMLElement, opts: TooltipOptions): void {
  if (!el || el.getAttribute('data-gm-tooltip-bound') === '1') return;
  el.setAttribute('data-gm-tooltip-bound', '1');
  el.setAttribute('data-tooltip', opts.text);
  if (opts.position) el.setAttribute('data-tooltip-pos', opts.position);

  const delay = opts.delay !== undefined ? opts.delay : DELAY_DEFAULT;
  const schedule = (show: boolean): void => {
    const existing = pending.get(el);
    if (existing) clearTimeout(existing);
    if (!show) {
      hideTooltip(el);
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(el);
      showTooltip(el, { ...opts, delay });
    }, delay);
    pending.set(el, timer);
  };

  el.addEventListener('mouseenter', () => schedule(true));
  el.addEventListener('mouseleave', () => schedule(false));
  el.addEventListener('focusin', () => schedule(true));
  el.addEventListener('focusout', () => schedule(false));

  el.setAttribute('aria-describedby', TOOLTIP_ID);
}

/** Binds every [data-tooltip] element inside `root` (defaults to document). */
export function initTooltips(root?: ParentNode): void {
  const scope: ParentNode = root ?? document;
  scope.querySelectorAll<HTMLElement>('[data-tooltip]').forEach((el) => {
    if (el.getAttribute('data-gm-tooltip-bound') === '1') return;
    const text = el.getAttribute('data-tooltip') || '';
    const position = el.getAttribute('data-tooltip-pos') === 'top' ? 'top' : 'bottom';
    let delay = DELAY_DEFAULT;
    const rawDelay = el.getAttribute('data-tooltip-delay');
    if (rawDelay && !Number.isNaN(Number(rawDelay)) && Number(rawDelay) >= 0) {
      delay = Number(rawDelay);
    }
    bindTooltip(el, { text, position, delay });
  });
}