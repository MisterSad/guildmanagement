/**
 * src/modules/tickets/views/TicketsView.ts
 *
 * Strangler Phase 1 port of the root `tickets.js` super-admin bug-ticket
 * console. Lists every bug report and lets the super admin set status.
 *
 * `loadingHtml()` is exported at module level (invariant consumed by the
 * skeleton-loader test suite). This module never assigns `window.GM_TICKETS`
 * (parity bridge is added at cutover in src/main.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { escapeHTML } from '../../../core/utils/text';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

const legacy = {
  esc(value: unknown): string {
    return escapeHTML(value);
  },
  t(key: string): string {
    const g = winAny().GM;
    return g && typeof g.t === 'function' ? g.t(key) : key;
  },
  formatNumber(value: unknown): string {
    const g = winAny().GM;
    return g && typeof g.formatNumber === 'function' ? g.formatNumber(value) : String(value ?? '');
  },
  isSuperAdmin(): boolean {
    const g = winAny().GM;
    return !!(g && typeof g.isSuperAdmin === 'function' && g.isSuperAdmin());
  },
  showToast(msg: string, type: string): void {
    const g = winAny().GM;
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  db(): any {
    const g = winAny().GM;
    return g && g.db ? g.db : null;
  }
};

const SEVERITY_COLOR: Record<string, string> = {
  low:      'background:rgba(148,163,184,0.14); color:#94a3b8; border:1px solid rgba(148,163,184,0.3);',
  medium:   'background:rgba(245,158,11,0.14); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);',
  high:     'background:rgba(249,115,22,0.14); color:#fb923c; border:1px solid rgba(249,115,22,0.3);',
  critical: 'background:rgba(239,68,68,0.14); color:#f87171; border:1px solid rgba(239,68,68,0.3);'
};

const STATUS_LABEL: Record<string, string> = {
  waiting:     'tickets_status_waiting',
  in_progress: 'tickets_status_in_progress',
  open:        'tickets_status_waiting',
  resolved:    'tickets_status_resolved',
  closed:      'tickets_status_closed'
};

const CATEGORY: Record<string, string> = { bug: 'ticket_cat_bug', feature: 'ticket_cat_feature', other: 'ticket_cat_other' };

/** Skeleton markup while tickets are loading (module-level export = test invariant). */
export function loadingHtml(): string {
  let cards = '';
  for (let i = 0; i < 4; i++) {
    cards +=
      '<div class="gm-card gm-card-padded gm-skeleton-card" style="margin-bottom:0.75rem;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; margin-bottom:0.4rem;">' +
          '<div style="display:flex; align-items:center; gap:0.5rem;">' +
            '<div class="gm-skeleton gm-skeleton-text" style="width:85px; height:1rem;"></div>' +
            '<div class="gm-skeleton gm-skeleton-badge" style="width:70px; height:1.25rem;"></div>' +
            '<div class="gm-skeleton gm-skeleton-badge" style="width:65px; height:1.25rem;"></div>' +
          '</div>' +
          '<div class="gm-skeleton gm-skeleton-text" style="width:110px; height:0.8rem;"></div>' +
        '</div>' +
        '<div class="gm-skeleton gm-skeleton-title" style="width:' + (50 + (i % 3) * 18) + '%; height:1.25rem; margin-bottom:0.4rem;"></div>' +
        '<div class="gm-skeleton gm-skeleton-text" style="width:' + (75 + (i % 2) * 20) + '%; height:0.85rem; margin-bottom:0.4rem;"></div>' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.5rem; padding-top:0.4rem; border-top:1px solid var(--border-soft);">' +
          '<div class="gm-skeleton gm-skeleton-text" style="width:130px; height:0.8rem;"></div>' +
          '<div class="gm-skeleton gm-skeleton-btn" style="width:90px; height:1.85rem; border-radius:6px;"></div>' +
        '</div>' +
      '</div>';
  }
  return '<div class="gm-tickets-skeleton-list" aria-busy="true" aria-label="Loading tickets">' + cards + '</div>';
}

function pad(n: number | string): string {
  return String(n).padStart(4, '0');
}

function statusChip(status: string): string {
  const s = (status === 'open') ? 'waiting' : status;
  const label = STATUS_LABEL[s] ? legacy.t(STATUS_LABEL[s]) : s;
  const bg = (s === 'waiting')
    ? 'background:rgba(245,158,11,0.14); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);'
    : (s === 'in_progress')
      ? 'background:rgba(59,130,246,0.14); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);'
      : (s === 'resolved')
        ? 'background:rgba(16,185,129,0.14); color:#34d399; border:1px solid rgba(16,185,129,0.3);'
        : 'background:rgba(100,116,139,0.14); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);';
  return '<span class="gm-chip" style="font-size:0.72rem; font-weight:700; padding:2px 9px; border-radius:9999px; ' + bg + ';">' + legacy.esc(label) + '</span>';
}

function severityChip(sev: string): string {
  const label = sev.charAt(0).toUpperCase() + sev.slice(1);
  const bg = SEVERITY_COLOR[sev] || SEVERITY_COLOR.medium;
  return '<span class="gm-chip" style="font-size:0.72rem; font-weight:700; padding:2px 9px; border-radius:9999px; ' + bg + ';">' + legacy.esc(label) + '</span>';
}

export class TicketsView {
  /** Render the ticket list into #tickets-container (super-admin only). */
  public async load(): Promise<void> {
    const container = document.getElementById('tickets-container');
    if (!container) return;
    const db = legacy.db();
    if (!db || !db.functions) {
      container.innerHTML = loadingHtml();
      return;
    }
    if (!legacy.isSuperAdmin()) {
      container.innerHTML = '<div class="gm-empty"><i class="ph ph-shield-warning gm-icon"></i><div class="gm-empty-title">Super admin only</div></div>';
      return;
    }

    container.innerHTML = loadingHtml();
    try {
      const res = await db.functions.invoke('tickets', { body: { action: 'list' } });
      const data = res && res.data;
      if (!data || !data.ok) throw new Error((data && data.error) || 'list_failed');
      this.render(container, data.tickets || []);
    } catch (err) {
      console.error('tickets load error', err);
      container.innerHTML =
        '<div class="gm-empty">' +
          '<i class="ph ph-warning-circle gm-icon"></i>' +
          '<div class="gm-empty-title">Could not load tickets</div>' +
          '<button class="gm-btn gm-btn-outline" data-tickets-retry><i class="ph ph-arrows-clockwise"></i> Retry</button>' +
        '</div>';
      const retryBtn = container.querySelector('[data-tickets-retry]');
      if (retryBtn) retryBtn.addEventListener('click', () => { void this.load(); });
    }
  }

  public loadingHtml(): string {
    return loadingHtml();
  }

  private render(container: Element, tickets: any[]): void {
    if (!tickets || tickets.length === 0) {
      container.innerHTML = '<div class="gm-empty"><i class="ph ph-ticket gm-icon"></i><div class="gm-empty-title">' + legacy.esc(legacy.t('tickets_empty')) + '</div></div>';
      return;
    }

    let html =
      '<div class="gm-table-wrap" style="background:var(--bg-1); border:1px solid var(--border-soft); border-radius:var(--radius-lg); overflow-x:auto;">' +
        '<table class="gm-table gm-resp-table" style="width:100%; border-collapse:collapse; min-width:820px;">' +
          '<thead><tr style="background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted);">' +
            '<th style="padding:0.65rem 0.75rem; text-align:left;">#</th>' +
            '<th style="padding:0.65rem 0.5rem; text-align:left;">' + legacy.esc(legacy.t('tickets_reporter')) + '</th>' +
            '<th style="padding:0.65rem 0.5rem; text-align:left;">' + legacy.esc(legacy.t('tickets_category')) + '</th>' +
            '<th style="padding:0.65rem 0.5rem; text-align:center;">' + legacy.esc(legacy.t('tickets_severity')) + '</th>' +
            '<th style="padding:0.65rem 0.5rem; text-align:center;">Status</th>' +
            '<th style="padding:0.65rem 0.75rem; text-align:left;">Title</th>' +
            '<th style="padding:0.65rem 0.5rem; text-align:left;">' + legacy.esc(legacy.t('tickets_date')) + '</th>' +
            '<th style="padding:0.65rem 0.75rem; text-align:center;">Set status</th>' +
          '</tr></thead><tbody>';

    tickets.forEach((tk) => {
      const cat = CATEGORY[tk.category] ? legacy.t(CATEGORY[tk.category]) : (tk.category || '');
      const guildLabel = tk.guild ? legacy.esc(tk.guild) : 'Global';
      const dateStr = tk.created_at ? new Date(tk.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
      const rawDesc = tk.description || '';
      const desc = legacy.esc(rawDesc).replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--fg); font-weight:700; display:inline-block; margin-top:0.25rem;">$1</strong>');

      let attachHtml = '';
      if (Array.isArray(tk.attachments) && tk.attachments.length > 0) {
        attachHtml = '<div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.45rem;">';
        tk.attachments.forEach((attUrl: string) => {
          attachHtml += '<img src="' + legacy.esc(attUrl) + '" class="gm-ticket-thumb" data-full="' + legacy.esc(attUrl) + '" style="width:54px; height:42px; object-fit:cover; border-radius:4px; border:1px solid var(--border-soft); cursor:pointer; transition:transform 0.15s;" title="Click to view screenshot">';
        });
        attachHtml += '</div>';
      }
      const curStatus = (tk.status === 'open') ? 'waiting' : (tk.status || 'waiting');

      html +=
        '<tr style="border-bottom:1px solid var(--border-soft); vertical-align:top;">' +
          '<td data-label="#" style="padding:0.65rem 0.75rem; font-weight:700; font-variant-numeric:tabular-nums;">#TICKET-' + legacy.esc(pad(tk.ticket_number)) + '</td>' +
          '<td data-label="' + legacy.esc(legacy.t('tickets_reporter')) + '" style="padding:0.65rem 0.5rem;">' +
            '<div style="font-weight:600; font-size:0.85rem;">' + legacy.esc(tk.reporter_account_id) + '</div>' +
            '<div style="font-size:0.7rem; color:var(--text-muted);">' + legacy.esc(tk.reporter_role) + ' · ' + guildLabel + '</div>' +
          '</td>' +
          '<td data-label="' + legacy.esc(legacy.t('tickets_category')) + '" style="padding:0.65rem 0.5rem; font-size:0.82rem;">' + legacy.esc(cat) + '</td>' +
          '<td data-label="' + legacy.esc(legacy.t('tickets_severity')) + '" style="padding:0.65rem 0.5rem; text-align:center;">' + severityChip(tk.severity) + '</td>' +
          '<td data-label="Status" style="padding:0.65rem 0.5rem; text-align:center;">' + statusChip(tk.status) + '</td>' +
          '<td data-label="Title" style="padding:0.65rem 0.5rem; min-width:260px;">' +
            '<div style="font-weight:700; font-size:0.92rem; color:var(--fg);">' + legacy.esc(tk.title) + '</div>' +
            (desc ? '<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.35rem; line-height:1.45; white-space:pre-wrap; background:rgba(0,0,0,0.18); padding:0.5rem 0.65rem; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">' + desc + '</div>' : '') +
            attachHtml +
          '</td>' +
          '<td data-label="' + legacy.esc(legacy.t('tickets_date')) + '" style="padding:0.65rem 0.5rem; font-size:0.78rem; color:var(--text-muted); white-space:nowrap;">' + legacy.esc(dateStr) + '</td>' +
          '<td data-label="' + legacy.esc(legacy.t('tickets_set')) + '" style="padding:0.65rem 0.75rem; text-align:center;">' +
            '<select class="gm-select gm-select-sm gm-ticket-status" data-id="' + legacy.esc(tk.id) + '" data-ticket-no="' + legacy.esc(tk.ticket_number) + '" style="font-size:0.75rem; padding:0.15rem 0.4rem; height:auto; width:auto; min-width:145px; border-radius:4px;">' +
              '<option value="waiting"' + (curStatus === 'waiting' ? ' selected' : '') + '>⏳ ' + legacy.esc(legacy.t('tickets_status_waiting')) + '</option>' +
              '<option value="in_progress"' + (curStatus === 'in_progress' ? ' selected' : '') + '>🔨 ' + legacy.esc(legacy.t('tickets_status_in_progress')) + '</option>' +
              '<option value="resolved"' + (curStatus === 'resolved' ? ' selected' : '') + '>✅ ' + legacy.esc(legacy.t('tickets_status_resolved')) + '</option>' +
              '<option value="closed"' + (curStatus === 'closed' ? ' selected' : '') + '>🔒 ' + legacy.esc(legacy.t('tickets_status_closed')) + '</option>' +
            '</select>' +
          '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;

    container.querySelectorAll('.gm-ticket-status').forEach((sel) => {
      sel.addEventListener('change', () => {
        void this.updateStatus(sel.getAttribute('data-id') || '', (sel as HTMLSelectElement).value, sel as HTMLSelectElement);
      });
    });

    container.querySelectorAll('.gm-ticket-thumb').forEach((img) => {
      img.addEventListener('click', () => {
        this.openLightbox(img.getAttribute('data-full') || '');
      });
    });
  }

  private openLightbox(src: string): void {
    if (!src) return;
    const modal = document.createElement('div');
    modal.className = 'gm-modal-overlay visible';
    (modal as HTMLElement).style.zIndex = '9999';
    modal.innerHTML =
      '<div style="position:relative; max-width:92vw; max-height:92vh; display:flex; flex-direction:column; align-items:center;">' +
        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon" style="position:absolute; top:-38px; right:0; color:#fff; font-size:1.4rem;" title="Close">✕</button>' +
        '<img src="' + legacy.esc(src) + '" style="max-width:100%; max-height:85vh; object-fit:contain; border-radius:8px; box-shadow:0 8px 30px rgba(0,0,0,0.8); border:1px solid rgba(255,255,255,0.1);">' +
      '</div>';
    document.body.appendChild(modal);
    const close = (): void => { if (modal && modal.parentNode) modal.parentNode.removeChild(modal); };
    modal.addEventListener('click', close);
  }

  private async updateStatus(id: string, status: string, sel: HTMLSelectElement): Promise<void> {
    const db = legacy.db();
    if (!db || !db.functions) return;
    const original = sel.value;
    sel.disabled = true;
    try {
      const res = await db.functions.invoke('tickets', { body: { action: 'update-status', id: Number(id), status } });
      const data = res && res.data;
      if (!data || !data.ok) throw new Error((data && data.error) || 'update_failed');
      legacy.showToast('Ticket updated', 'success');
      await this.load();
    } catch (err) {
      console.error('ticket status update error', err);
      sel.value = original;
      legacy.showToast('Could not update ticket', 'error');
    } finally {
      sel.disabled = false;
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_TICKETS` at cutover). */
export const ticketsView = new TicketsView();

export default ticketsView;
