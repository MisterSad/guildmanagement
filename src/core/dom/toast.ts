/**
 * src/core/dom/toast.ts
 *
 * Toast feedback (port of gm-utils.js#showToast), built safely via pure DOM
 * APIs (never innerHTML with user data).
 */

/**
 * Concrete toast renderer: always builds the toast itself and never delegates
 * back to `GM_APP.showToast` (this is the implementation the app bridge points
 * at, so delegating here would recurse).
 */
export function renderToast(message: unknown, type?: string, duration?: number): void {
  if (typeof document === 'undefined') return;
  const tc = document.getElementById('toast-container');
  if (!tc) return;

  const icons: Record<string, string> = {
    success: 'ph-check-circle',
    error: 'ph-warning-circle',
    warning: 'ph-warning',
    info: 'ph-info'
  };

  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');

  const icon = document.createElement('i');
  icon.className = 'ph ' + (icons[type as string] || 'ph-info');
  const span = document.createElement('span');
  span.textContent = String(message);
  toast.appendChild(icon);
  toast.appendChild(document.createTextNode(' '));
  toast.appendChild(span);

  tc.appendChild(toast);
  const ttl = typeof duration === 'number' ? duration : 3500;
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => { toast.remove(); }, 300);
  }, ttl);
}

/**
 * The app's toast. It used to go through `window.GM_APP.showToast`, which
 * main.ts pointed at `renderToast(message, type, 3500)`; it now renders that
 * directly (medium-term plan, M4c).
 */
export function showToast(message: unknown, type?: string, duration?: number): void {
  renderToast(message, type, duration ?? 3500);
}
