/**
 * src/components/ui/Toast.ts
 *
 * Modular Toast notification manager with auto-dismissal and clean animation.
 */

import { escapeHTML } from '../../core/api/supabase';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export class ToastNotification {
  private static containerId = 'toast-container';

  public static show(message: string, type: ToastType = 'info', durationMs = 3500): void {
    if (typeof document === 'undefined') return;

    let container = document.getElementById(this.containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = this.containerId;
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `gm-toast gm-toast-${type} slide-up`;
    toast.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1.25rem;
      margin-bottom: 0.5rem;
      border-radius: var(--radius-md, 8px);
      background: var(--bg-2, #1f1d2b);
      border: 1px solid var(--border-soft, rgba(255,255,255,0.1));
      color: var(--text-normal, #e2e8f0);
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
      font-size: 0.9rem;
      z-index: 9999;
    `;

    const iconMap: Record<ToastType, string> = {
      success: 'ph-check-circle text-success',
      error: 'ph-warning-circle text-danger',
      info: 'ph-info text-accent',
      warning: 'ph-warning text-warning'
    };

    toast.innerHTML = `
      <i class="ph ${iconMap[type]}" style="font-size: 1.25rem;"></i>
      <span>${escapeHTML(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, durationMs);
  }
}
