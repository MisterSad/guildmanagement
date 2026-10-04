/**
 * src/modules/sanctions/views/SanctionsView.ts
 *
 * Strangler Phase 1 port of the root `sanctions.js` tracking/history view.
 * Lists guild sanctions, fills the member datalist, and wires the
 * `#apply-sanction-form` submit plus the `rad-lang-change` re-render.
 *
 * The legacy script self-initialised its listeners at parse time; this port
 * exposes an explicit `init()` (called by src/main.ts at DOMContentLoaded) and
 * a `destroy()` for test cleanup.
 *
 * This module never assigns `window.GM_SANCTIONS` (bridge added at cutover).
 */

import { escapeHTML, avatarInit } from '../../../core/utils/text';
import { t } from '../../../core/i18n/i18n';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild } from '../../../core/auth/roles';
import { showToast } from '../../../core/dom/toast';
import { showConfirm } from '../../app/dialogs/dialogs.service';
import { queryMemberPseudos, querySanctions, insertSanction, deleteSanction } from '../sanctions.service';

interface SanctionRow {
  id?: string | number;
  pseudo?: string;
  comment?: string;
  created_at?: string;
  created_by?: string;
  [key: string]: any;
}

export class SanctionsView {
  private sanctions: SanctionRow[] = [];
  private langChangeHandler?: () => void;

  public async load(): Promise<void> {
    const db = getClient();
    if (!db) return;

    const currentG = getActiveGuild();
    const membersQ = queryMemberPseudos(db, currentG);
    const sanctionsQ = querySanctions(db, currentG);

    const [membersRes, res] = await Promise.all([membersQ, sanctionsQ]);

    const datalist = document.getElementById('member-list-datalist');
    if (datalist && membersRes.data) {
      datalist.innerHTML = (membersRes.data as any[])
        .map((m) => '<option value="' + escapeHTML(m.pseudo) + '">')
        .join('');
    }

    this.sanctions = (res.data || []) as SanctionRow[];
    this.render();
  }

  /** Attach the form submit + language-change listeners (legacy parse-time init). */
  public init(): void {
    if (this.langChangeHandler) return; // idempotent

    const form = document.getElementById('apply-sanction-form') as HTMLFormElement | null;
    if (form && !(form as any).__gmSanctionsWired) {
      (form as any).__gmSanctionsWired = true;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pseudoInput = document.getElementById('sanction-player') as HTMLInputElement | null;
        const commentInput = document.getElementById('sanction-comment') as HTMLTextAreaElement | null;
        if (!pseudoInput || !commentInput) return;
        const pseudo = pseudoInput.value.trim();
        const comment = commentInput.value.trim();
        if (!pseudo || !comment) return;

        const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (btn) btn.disabled = true;

        try {
          const db = getClient();
          if (!db) return;
          const currentG = getActiveGuild();
          const res = await insertSanction(db, currentG, pseudo, comment);
          if (res.error) throw res.error;

          pseudoInput.value = '';
          commentInput.value = '';
          showToast(t('toast_sanction_added'), 'success');
          await this.load();
          this.checkRecidivist(pseudo);
        } catch (err: any) {
          showToast(err.message, 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    this.langChangeHandler = () => {
      const activeTab = document.querySelector('.nav-tab.active');
      if (activeTab && activeTab.getAttribute('data-tab') === 'tab-sanctions') {
        this.render();
      }
    };
    window.addEventListener('rad-lang-change', this.langChangeHandler);
  }

  public destroy(): void {
    if (this.langChangeHandler) {
      window.removeEventListener('rad-lang-change', this.langChangeHandler);
      this.langChangeHandler = undefined;
    }
    const form = document.getElementById('apply-sanction-form') as any;
    if (form) delete form.__gmSanctionsWired;
  }

  public getState(): SanctionRow[] {
    return this.sanctions;
  }

  private render(): void {
    const list = document.getElementById('sanctions-list');
    const count = document.getElementById('sanctions-count');
    if (!list) return;

    if (count) count.textContent = String(this.sanctions.length);

    if (this.sanctions.length === 0) {
      list.innerHTML =
        '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' +
        t('empty_sanctions') +
        '</div></div>';
      return;
    }

    let html = '<div class="gm-sanction-list">';
    const locale = 'en-GB';

    this.sanctions.forEach((s) => {
      const dateStr = new Date(s.created_at as string).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      } as any);
      const author = s.created_by || '-';
      const initial = avatarInit(s.pseudo);
      html +=
        '<div class="gm-sanction-row">' +
        '<div class="u-gap-0_5rem gm-row">' +
        '<div class="gm-avatar">' +
        escapeHTML(initial) +
        '</div>' +
        '<strong>' +
        escapeHTML(s.pseudo) +
        '</strong>' +
        '</div>' +
        '<div class="gm-sanction-comment">"' +
        escapeHTML(s.comment) +
        '"</div>' +
        '<div class="gm-sanction-meta">' +
        t('sanction_by') +
        ' <strong class="u-c-accent">' +
        escapeHTML(author) +
        '</strong> · ' +
        dateStr +
        '</div>' +
        '<button class="u-c-danger gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm sanction-delete-btn" data-id="' +
        s.id +
        '" title="' +
        t('delete_title') +
        '">' +
        '<i class="ph ph-trash"></i>' +
        '</button>' +
        '</div>';
    });
    html += '</div>';
    list.innerHTML = html;

    list.querySelectorAll('.sanction-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id') || '';
        showConfirm(t('confirm_delete_sanction_title'), t('confirm_delete_sanction_body'), () => {
          void this.deleteSanction(id);
        });
      });
    });
  }

  private checkRecidivist(pseudo: string): void {
    const count = this.sanctions.filter((s) => s.pseudo === pseudo).length;
    if (count >= 3) {
      setTimeout(() => {
        showConfirm(
          t('alert_recidivist'),
          '<strong>' + escapeHTML(pseudo) + '</strong> : ' + count + ' ' + t('nav_sanctions'),
          () => {
            /* informational */
          }
        );
      }, 500);
    }
  }

  private async deleteSanction(id: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      const res = await deleteSanction(db, id);
      if (res.error) throw res.error;
      await this.load();
      showToast(t('toast_sanction_deleted'), 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_SANCTIONS` at cutover). */
export const sanctionsView = new SanctionsView();

export default sanctionsView;
