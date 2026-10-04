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

import { styleRef } from '../../../core/dom/style-refs';
import { adoptDialog } from '../../../components/ui/Dialog';
import { escapeHTML } from '../../../core/utils/text';
import { t } from '../../../core/i18n/i18n';
import { getClient } from '../../../core/api/supabase';
import { isSuperAdmin } from '../../../core/auth/roles';
import { showToast } from '../../../core/dom/toast';
import { listTickets, updateTicketStatus } from '../tickets.service';

const SEVERITY_COLOR: Record<string, string> = {
  low: 'background:rgba(148,163,184,0.14); color:#94a3b8; border:1px solid rgba(148,163,184,0.3);',
  medium: 'background:rgba(245,158,11,0.14); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);',
  high: 'background:rgba(249,115,22,0.14); color:#fb923c; border:1px solid rgba(249,115,22,0.3);',
  critical: 'background:rgba(239,68,68,0.14); color:#f87171; border:1px solid rgba(239,68,68,0.3);',
};

const STATUS_LABEL: Record<string, string> = {
  waiting: 'tickets_status_waiting',
  in_progress: 'tickets_status_in_progress',
  open: 'tickets_status_waiting',
  resolved: 'tickets_status_resolved',
  closed: 'tickets_status_closed',
};

const CATEGORY: Record<string, string> = {
  bug: 'ticket_cat_bug',
  feature: 'ticket_cat_feature',
  other: 'ticket_cat_other',
};

/** Skeleton markup while tickets are loading (module-level export = test invariant). */
export function loadingHtml(): string {
  let cards = '';
  for (let i = 0; i < 4; i++) {
    cards +=
      '<div class="u-mb-0_75rem gm-card gm-card-padded gm-skeleton-card">' +
      '<div class="u-d-flex u-justify-space-between u-items-center u-gap-0_75rem u-mb-0_4rem">' +
      '<div class="u-d-flex u-items-center u-gap-0_5rem">' +
      '<div class="u-w-85px u-h-1rem gm-skeleton gm-skeleton-text"></div>' +
      '<div class="u-w-70px u-h-1_25rem gm-skeleton gm-skeleton-badge"></div>' +
      '<div class="u-w-65px u-h-1_25rem gm-skeleton gm-skeleton-badge"></div>' +
      '</div>' +
      '<div class="u-w-110px u-h-0_8rem gm-skeleton gm-skeleton-text"></div>' +
      '</div>' +
      '<div class="gm-skeleton gm-skeleton-title" data-gm-style="' +
      styleRef('width:' + (50 + (i % 3) * 18) + '%; height:1.25rem; margin-bottom:0.4rem;') +
      '"></div>' +
      '<div class="gm-skeleton gm-skeleton-text" data-gm-style="' +
      styleRef('width:' + (75 + (i % 2) * 20) + '%; height:0.85rem; margin-bottom:0.4rem;') +
      '"></div>' +
      '<div class="u-d-flex u-justify-space-between u-items-center u-mt-0_5rem u-pt-0_4rem u-bt-1px-solid-border-soft">' +
      '<div class="u-w-130px u-h-0_8rem gm-skeleton gm-skeleton-text"></div>' +
      '<div class="u-w-90px u-h-1_85rem u-rounded-6px gm-skeleton gm-skeleton-btn"></div>' +
      '</div>' +
      '</div>';
  }
  return '<div class="gm-tickets-skeleton-list" aria-busy="true" aria-label="Loading tickets">' + cards + '</div>';
}

function pad(n: number | string): string {
  return String(n).padStart(4, '0');
}

function statusChip(status: string): string {
  const s = status === 'open' ? 'waiting' : status;
  const label = STATUS_LABEL[s] ? t(STATUS_LABEL[s]) : s;
  const bg =
    s === 'waiting'
      ? 'background:rgba(245,158,11,0.14); color:#fbbf24; border:1px solid rgba(245,158,11,0.3);'
      : s === 'in_progress'
        ? 'background:rgba(59,130,246,0.14); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);'
        : s === 'resolved'
          ? 'background:rgba(16,185,129,0.14); color:#34d399; border:1px solid rgba(16,185,129,0.3);'
          : 'background:rgba(100,116,139,0.14); color:#94a3b8; border:1px solid rgba(100,116,139,0.3);';
  return (
    '<span class="gm-chip" data-gm-style="' +
    styleRef('font-size:0.72rem; font-weight:700; padding:2px 9px; border-radius:9999px; ' + bg + ';') +
    '">' +
    escapeHTML(label) +
    '</span>'
  );
}

function severityChip(sev: string): string {
  const label = sev.charAt(0).toUpperCase() + sev.slice(1);
  const bg = SEVERITY_COLOR[sev] || SEVERITY_COLOR.medium;
  return (
    '<span class="gm-chip" data-gm-style="' +
    styleRef('font-size:0.72rem; font-weight:700; padding:2px 9px; border-radius:9999px; ' + bg + ';') +
    '">' +
    escapeHTML(label) +
    '</span>'
  );
}

export class TicketsView {
  /** Render the ticket list into #tickets-container (super-admin only). */
  public async load(): Promise<void> {
    const container = document.getElementById('tickets-container');
    if (!container) return;
    const db = getClient();
    if (!db || !db.functions) {
      container.innerHTML = loadingHtml();
      return;
    }
    if (!isSuperAdmin()) {
      container.innerHTML =
        '<div class="gm-empty"><i class="ph ph-shield-warning gm-icon"></i><div class="gm-empty-title">Super admin only</div></div>';
      return;
    }

    container.innerHTML = loadingHtml();
    try {
      const res = await listTickets(db);
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
      if (retryBtn)
        retryBtn.addEventListener('click', () => {
          void this.load();
        });
    }
  }

  public loadingHtml(): string {
    return loadingHtml();
  }

  private render(container: Element, tickets: any[]): void {
    if (!tickets || tickets.length === 0) {
      container.innerHTML =
        '<div class="gm-empty"><i class="ph ph-ticket gm-icon"></i><div class="gm-empty-title">' +
        escapeHTML(t('tickets_empty')) +
        '</div></div>';
      return;
    }

    let html =
      '<div class="u-bg-bg-1 u-border-1px-solid-border-soft u-rounded-radius-lg u-ox-auto gm-table-wrap">' +
      '<table class="u-w-100pct u-bcol-collapse u-minw-820px gm-table gm-resp-table">' +
      '<thead><tr class="u-bg-rgba-255-255-255-0_03 u-bb-1px-solid-border-soft u-fs-0_72rem u-tt-uppercase u-tracking-0_05em u-c-text-muted">' +
      '<th class="u-p-0_65rem-0_75rem u-text-left">#</th>' +
      '<th class="u-p-0_65rem-0_5rem u-text-left">' +
      escapeHTML(t('tickets_reporter')) +
      '</th>' +
      '<th class="u-p-0_65rem-0_5rem u-text-left">' +
      escapeHTML(t('tickets_category')) +
      '</th>' +
      '<th class="u-p-0_65rem-0_5rem u-text-center">' +
      escapeHTML(t('tickets_severity')) +
      '</th>' +
      '<th class="u-p-0_65rem-0_5rem u-text-center">Status</th>' +
      '<th class="u-p-0_65rem-0_75rem u-text-left">Title</th>' +
      '<th class="u-p-0_65rem-0_5rem u-text-left">' +
      escapeHTML(t('tickets_date')) +
      '</th>' +
      '<th class="u-p-0_65rem-0_75rem u-text-center">Set status</th>' +
      '</tr></thead><tbody>';

    tickets.forEach((tk) => {
      const cat = CATEGORY[tk.category] ? t(CATEGORY[tk.category]) : tk.category || '';
      const guildLabel = tk.guild ? escapeHTML(tk.guild) : 'Global';
      const dateStr = tk.created_at
        ? new Date(tk.created_at).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '-';
      const rawDesc = tk.description || '';
      const desc = escapeHTML(rawDesc).replace(
        /\*\*(.*?)\*\*/g,
        '<strong class="u-c-fg u-fw-700 u-d-inline-block u-mt-0_25rem">$1</strong>'
      );

      let attachHtml = '';
      if (Array.isArray(tk.attachments) && tk.attachments.length > 0) {
        attachHtml = '<div class="u-d-flex u-wrap-wrap u-gap-0_4rem u-mt-0_45rem">';
        tk.attachments.forEach((attUrl: string) => {
          attachHtml +=
            '<img src="' +
            escapeHTML(attUrl) +
            '" class="u-w-54px u-h-42px u-fit-cover u-rounded-4px u-border-1px-solid-border-soft u-cursor-pointer u-transition-transform-0_15s gm-ticket-thumb" data-full="' +
            escapeHTML(attUrl) +
            '" title="Click to view screenshot">';
        });
        attachHtml += '</div>';
      }
      const curStatus = tk.status === 'open' ? 'waiting' : tk.status || 'waiting';

      html +=
        '<tr class="u-bb-1px-solid-border-soft u-va-top">' +
        '<td data-label="#" class="u-p-0_65rem-0_75rem u-fw-700 u-fvn-tabular-nums">#TICKET-' +
        escapeHTML(pad(tk.ticket_number)) +
        '</td>' +
        '<td data-label="' +
        escapeHTML(t('tickets_reporter')) +
        '" class="u-p-0_65rem-0_5rem">' +
        '<div class="u-fw-600 u-fs-0_85rem">' +
        escapeHTML(tk.reporter_account_id) +
        '</div>' +
        '<div class="u-fs-0_7rem u-c-text-muted">' +
        escapeHTML(tk.reporter_role) +
        ' · ' +
        guildLabel +
        '</div>' +
        '</td>' +
        '<td data-label="' +
        escapeHTML(t('tickets_category')) +
        '" class="u-p-0_65rem-0_5rem u-fs-0_82rem">' +
        escapeHTML(cat) +
        '</td>' +
        '<td data-label="' +
        escapeHTML(t('tickets_severity')) +
        '" class="u-p-0_65rem-0_5rem u-text-center">' +
        severityChip(tk.severity) +
        '</td>' +
        '<td data-label="Status" class="u-p-0_65rem-0_5rem u-text-center">' +
        statusChip(tk.status) +
        '</td>' +
        '<td data-label="Title" class="u-p-0_65rem-0_5rem u-minw-260px">' +
        '<div class="u-fw-700 u-fs-0_92rem u-c-fg">' +
        escapeHTML(tk.title) +
        '</div>' +
        (desc
          ? '<div class="u-fs-0_8rem u-c-text-muted u-mt-0_35rem u-lh-1_45 u-ws-pre-wrap u-bg-rgba-0-0-0-0_18 u-p-0_5rem-0_65rem u-rounded-6px u-border-1px-solid-rgba-255-355fe4">' +
            desc +
            '</div>'
          : '') +
        attachHtml +
        '</td>' +
        '<td data-label="' +
        escapeHTML(t('tickets_date')) +
        '" class="u-p-0_65rem-0_5rem u-fs-0_78rem u-c-text-muted u-ws-nowrap">' +
        escapeHTML(dateStr) +
        '</td>' +
        '<td data-label="' +
        escapeHTML(t('tickets_set')) +
        '" class="u-p-0_65rem-0_75rem u-text-center">' +
        '<select class="u-fs-0_75rem u-p-0_15rem-0_4rem u-h-auto u-w-auto u-minw-145px u-rounded-4px gm-select gm-select-sm gm-ticket-status" data-id="' +
        escapeHTML(tk.id) +
        '" data-ticket-no="' +
        escapeHTML(tk.ticket_number) +
        '" aria-label="' +
        escapeHTML(t('tickets_set') + ', #' + tk.ticket_number) +
        '">' +
        '<option value="waiting"' +
        (curStatus === 'waiting' ? ' selected' : '') +
        '>⏳ ' +
        escapeHTML(t('tickets_status_waiting')) +
        '</option>' +
        '<option value="in_progress"' +
        (curStatus === 'in_progress' ? ' selected' : '') +
        '>🔨 ' +
        escapeHTML(t('tickets_status_in_progress')) +
        '</option>' +
        '<option value="resolved"' +
        (curStatus === 'resolved' ? ' selected' : '') +
        '>✅ ' +
        escapeHTML(t('tickets_status_resolved')) +
        '</option>' +
        '<option value="closed"' +
        (curStatus === 'closed' ? ' selected' : '') +
        '>🔒 ' +
        escapeHTML(t('tickets_status_closed')) +
        '</option>' +
        '</select>' +
        '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;

    container.querySelectorAll('.gm-ticket-status').forEach((sel) => {
      sel.addEventListener('change', () => {
        void this.updateStatus(
          sel.getAttribute('data-id') || '',
          (sel as HTMLSelectElement).value,
          sel as HTMLSelectElement
        );
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
      '<div class="u-pos-relative u-maxw-92vw u-maxh-92vh u-d-flex u-dir-column u-items-center">' +
      '<button type="button" class="u-pos-absolute u-top-neg38px u-right-0 u-c-hexfff u-fs-1_4rem gm-btn gm-btn-ghost gm-btn-icon" title="Close" aria-label="Close">✕</button>' +
      '<img src="' +
      escapeHTML(src) +
      '" alt="Ticket screenshot" class="u-maxw-100pct u-maxh-85vh u-fit-contain u-rounded-8px u-shadow-0-8px-30px-rgba-0-0-0-0_8 u-border-1px-solid-rgba-255-e5a8aa">' +
      '</div>';
    document.body.appendChild(modal);
    const close = (): void => {
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    };
    modal.addEventListener('click', close);
    adoptDialog(modal, { card: modal.firstElementChild as HTMLElement, label: 'Ticket screenshot', onEscape: close });
  }

  private async updateStatus(id: string, status: string, sel: HTMLSelectElement): Promise<void> {
    const db = getClient();
    if (!db || !db.functions) return;
    const original = sel.value;
    sel.disabled = true;
    try {
      const res = await updateTicketStatus(db, id, status);
      const data = res && res.data;
      if (!data || !data.ok) throw new Error((data && data.error) || 'update_failed');
      showToast('Ticket updated', 'success');
      await this.load();
    } catch (err) {
      console.error('ticket status update error', err);
      sel.value = original;
      showToast('Could not update ticket', 'error');
    } finally {
      sel.disabled = false;
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_TICKETS` at cutover). */
export const ticketsView = new TicketsView();

export default ticketsView;
