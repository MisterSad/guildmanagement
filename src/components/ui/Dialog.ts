/**
 * src/components/ui/Dialog.ts
 *
 * Accessible modal dialog (shadcn/ui philosophy) replacing the previous
 * ad-hoc .gm-modal-overlay surfaces:
 *   - ARIA: role="dialog", aria-modal="true", aria-labelledby/describedby
 *   - Focus trap (Tab cycling inside the card), Escape-to-close, backdrop-click
 *   - cva tone (default | danger) / size (sm | md | lg | full) variants
 *   - body accepts a pre-escaped HTML string OR an HTMLElement node
 *
 * Lifecycle: openDialog(opts) → closeDialog(root). Hooks: onConfirm
 * (primary button), onCancel (secondary button / Escape / backdrop / header X).
 * `onClose` fires on every close path.
 */

import { cva } from '../../core/utils/cva';
import { cn } from '../../core/utils/cn';
import { escapeHTML } from '../../core/utils/text';

export type DialogTone = 'default' | 'danger';
export type DialogSize = 'sm' | 'md' | 'lg' | 'full';

export interface DialogOptions {
  /** id on the backdrop/root element (kept for legacy getElementById lookups). */
  id?: string;
  title: string;
  /** Phosphor icon class name rendered before the title (internal constant). */
  iconClass?: string;
  /** Secondary line rendered under the title (pre-escaped). */
  subtitle?: string;
  /** Pre-escaped HTML or an element node — never raw un-processed input. */
  body: string | HTMLElement;
  /** i18n label for the primary action button. */
  confirmLabel?: string;
  /** i18n label for the secondary/cancel action button. */
  cancelLabel?: string;
  tone?: DialogTone;
  size?: DialogSize;
  /** Scrollable body (max-height + overflow-y). */
  scrollBody?: boolean;
  /** Extra element id assigned to the body container. */
  bodyId?: string;
  /** Extra element id assigned to the header close button. */
  headerCloseId?: string;
  /** Hides the built-in footer entirely (render actions inside `body`). */
  noFooter?: boolean;
  /**
   * Custom footer HTML (pre-escaped), placed in the dedicated footer zone so
   * destructive actions are kept away from the header close control. Children
   * carrying data-dialog-close / data-dialog-confirm are wired automatically.
   */
  footer?: string;
  /** Aria-describedby target id (e.g. a hint paragraph inside the body). */
  describedBy?: string;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
  onClose?: () => void;
  /** Initial focusable target; falls back to the first focusable element. */
  initialFocus?: HTMLElement | null;
}

export const dialogRecipe = cva('gm-ui-dialog', {
  variants: {
    tone: { default: 'gm-ui-dialog-default', danger: 'gm-ui-dialog-danger' },
    size: {
      sm: 'gm-ui-dialog-sm',
      md: 'gm-ui-dialog-md',
      lg: 'gm-ui-dialog-lg',
      full: 'gm-ui-dialog-full'
    }
  },
  defaultVariants: { tone: 'default', size: 'md' }
});

let uidCounter = 0;
const nextUid = (): string => 'gm-ui-dialog-' + (++uidCounter);

const cleanupRegistry = new WeakMap<HTMLElement, () => void>();

function titleIdFor(id: string): string {
  return (id || nextUid()) + '-title';
}

function focusableElements(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
}

/** Builds a detached dialog root (backdrop + card). No listeners attached. */
export function createDialog(opts: DialogOptions): HTMLElement {
  const id = opts.id || nextUid();
  const titleId = titleIdFor(id);
  const subtitleId = opts.subtitle ? (id + '-subtitle') : '';
  const bodyId = opts.bodyId || (id + '-body');
  const title = escapeHTML(opts.title);
  const cls = cn(dialogRecipe({ tone: opts.tone, size: opts.size }), 'gm-ui-dialog-wrap');
  const role = opts.tone === 'danger' ? 'alertdialog' : 'dialog';

  const headerCloseId = opts.headerCloseId || (id + '-close');
  const iconHtml = opts.iconClass && /^[a-z0-9 _-]+$/i.test(opts.iconClass)
    ? '<i class="ph-fill ' + opts.iconClass + '" aria-hidden="true"></i> '
    : '';
  const headingText =
    '<div class="gm-ui-dialog-heading-text">' +
      '<h2 class="gm-ui-dialog-title" id="' + titleId + '">' + title + '</h2>' +
      (opts.subtitle ? '<div class="gm-ui-dialog-subtitle" id="' + subtitleId + '">' + opts.subtitle + '</div>' : '') +
    '</div>';
  const headerHtml =
    '<div class="gm-ui-dialog-header">' +
      '<div class="gm-ui-dialog-heading">' + iconHtml + headingText + '</div>' +
      '<button type="button" class="gm-ui-dialog-header-close gm-btn gm-btn-ghost gm-btn-icon" id="' + headerCloseId + '" aria-label="' + escapeHTML(opts.cancelLabel || 'Close') + '"><i class="ph ph-x" aria-hidden="true"></i></button>' +
    '</div>';

  const bodyHtml = typeof opts.body === 'string'
    ? '<div class="gm-ui-dialog-body' + (opts.scrollBody ? ' gm-ui-dialog-scroll' : '') + '" id="' + bodyId + '">' + opts.body + '</div>'
    : '';

  let footerHtml = '';
  if (opts.footer) {
    footerHtml = '<div class="gm-ui-dialog-footer">' + opts.footer + '</div>';
  } else if (!opts.noFooter) {
    const hasConfirm = Boolean(opts.confirmLabel);
    const hasCancel = Boolean(opts.cancelLabel);
    if (hasConfirm || hasCancel) {
      const actions =
        (hasConfirm
          ? '<button type="button" class="gm-btn gm-ui-dialog-confirm' + (opts.tone === 'danger' ? ' gm-btn-danger" style="background:rgba(239,68,68,0.14); border:1px solid rgba(239,68,68,0.3); color:var(--danger);' : '" style="margin-left:auto;') + '"><span>' + escapeHTML(opts.confirmLabel) + '</span></button>'
          : '') +
        (hasCancel
          ? '<button type="button" class="gm-btn gm-btn-ghost gm-ui-dialog-cancel"><span>' + escapeHTML(opts.cancelLabel) + '</span></button>'
          : '');
      footerHtml = '<div class="gm-ui-dialog-footer gm-ui-dialog-footer-actions">' + actions + '</div>';
    }
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'gm-ui-dialog-backdrop';
  if (id && id !== '') backdrop.id = id;

  const describedById = opts.describedBy || subtitleId || '';
  const describedByAttr = describedById ? ' aria-describedby="' + escapeHTML(describedById) + '"' : '';
  backdrop.innerHTML =
    '<div class="' + cn(cls) + '" role="' + role + '" aria-modal="true" aria-labelledby="' + titleId + '"' + describedByAttr + ' tabindex="-1">' +
      headerHtml +
      bodyHtml +
      footerHtml +
    '</div>';

  if (opts.body && typeof opts.body !== 'string') {
    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'gm-ui-dialog-body' + (opts.scrollBody ? ' gm-ui-dialog-scroll' : '');
    bodyContainer.id = bodyId;
    bodyContainer.appendChild(opts.body);
    const card = backdrop.firstElementChild as HTMLElement | null;
    if (card) card.insertBefore(bodyContainer, card.querySelector('.gm-ui-dialog-footer'));
  }

  return backdrop;
}

export function dialogCard(dialog: HTMLElement): HTMLElement | null {
  return dialog ? dialog.querySelector<HTMLElement>('.gm-ui-dialog-wrap') : null;
}

/**
 * Opens a dialog: mounts it in <body>, wires Escape / Tab-trap / backdrop /
 * header-close / footer actions, gives focus to `initialFocus` (or the first
 * focusable) and returns the root element.
 */
export function openDialog(opts: DialogOptions): HTMLElement {
  const previouslyFocused = typeof document !== 'undefined'
    ? (document.activeElement as HTMLElement | null)
    : null;

  const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null;
  const prevAriaHidden = appRoot ? appRoot.getAttribute('aria-hidden') : null;
  if (appRoot) {
    appRoot.setAttribute('aria-hidden', 'true');
  }

  const dialog = createDialog(opts);
  const card = dialogCard(dialog);
  document.body.appendChild(dialog);

  const close = (): void => closeDialog(dialog);

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      opts.onCancel?.();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusableElements(card as HTMLElement);
    if (items.length === 0) {
      e.preventDefault();
      card?.focus();
      return;
    }
    const active = document.activeElement;
    const activeIdx = items.indexOf(active as HTMLElement);
    if (e.shiftKey) {
      if (activeIdx <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      }
    } else if (activeIdx === items.length - 1 || activeIdx === -1) {
      e.preventDefault();
      items[0].focus();
    }
  };

  const onBackdropClick = (e: MouseEvent): void => {
    if (e.target === dialog) {
      opts.onCancel?.();
      close();
    }
  };

  document.addEventListener('keydown', onKeydown, true);
  dialog.addEventListener('click', onBackdropClick);

  if (!opts.noFooter) {
    const footer = card?.querySelector<HTMLElement>('.gm-ui-dialog-footer');
    if (footer) {
      const confirmBtn = footer.querySelector('.gm-ui-dialog-confirm');
      confirmBtn?.addEventListener('click', () => {
        void Promise.resolve(opts.onConfirm ? opts.onConfirm() : undefined).then(() => close());
      });
      const cancelBtn = footer.querySelector('.gm-ui-dialog-cancel');
      cancelBtn?.addEventListener('click', () => {
        opts.onCancel?.();
        close();
      });
      // Custom-footers (e.g. HistoryView's danger zone): auto-wire data attrs.
      footer.querySelectorAll<HTMLElement>('[data-dialog-confirm]').forEach((btn) => {
        btn.addEventListener('click', () => {
          void Promise.resolve(opts.onConfirm ? opts.onConfirm() : undefined).then(() => close());
        });
      });
      footer.querySelectorAll<HTMLElement>('[data-dialog-close]').forEach((btn) => {
        btn.addEventListener('click', () => {
          opts.onCancel?.();
          close();
        });
      });
    }
  }

  const headerClose = card?.querySelector<HTMLElement>('.gm-ui-dialog-header-close');
  headerClose?.addEventListener('click', () => {
    opts.onCancel?.();
    close();
  });

  cleanupRegistry.set(dialog, () => {
    document.removeEventListener('keydown', onKeydown, true);
    dialog.removeEventListener('click', onBackdropClick);
    if (appRoot) {
      if (prevAriaHidden !== null) {
        appRoot.setAttribute('aria-hidden', prevAriaHidden);
      } else {
        appRoot.removeAttribute('aria-hidden');
      }
    }
    if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
      try { previouslyFocused.focus(); } catch { /* best effort */ }
    }
    opts.onClose?.();
  });

  const first = opts.initialFocus
    ? opts.initialFocus
    : focusableElements(card as HTMLElement)[0] ?? card;
  if (first) first.focus();

  return dialog;
}

/** Closes and removes the dialog; runs the onClose hook once. */
export function closeDialog(dialog: HTMLElement | null): void {
  if (!dialog) return;
  const cleanup = cleanupRegistry.get(dialog);
  if (cleanup) {
    cleanup();
    cleanupRegistry.delete(dialog);
  }
  dialog.remove();
}