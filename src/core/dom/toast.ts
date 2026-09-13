/**
 * src/core/dom/toast.ts
 *
 * Toast feedback (port of gm-utils.js#showToast). Prefers the app's own toast
 * host (window.GM_APP.showToast) and otherwise builds one safely via pure DOM
 * APIs (never innerHTML with user data).
 */

function winAny(): any {
  return (typeof window !== 'undefined' ? window : {}) as any;
}

export function showToast(message: unknown, type?: string, duration?: number): void {
  const w = winAny();
  if (w.GM_APP && typeof w.GM_APP.showToast === 'function') {
    w.GM_APP.showToast(message, type);
    return;
  }
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
  icon.className = 'ph-fill ' + (icons[type as string] || 'ph-info');
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
