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

/* eslint-disable @typescript-eslint/no-explicit-any */

import { escapeHTML } from '../../../core/utils/text';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

const legacy = {
  getDb(): any {
    const g = gm();
    return g && g.db ? g.db : null;
  },
  t(key: string): string {
    const g = gm();
    return g && typeof g.t === 'function' ? g.t(key) : key;
  },
  esc(value: unknown): string {
    return escapeHTML(value);
  },
  getActiveGuild(): string {
    const g = gm();
    return g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : 'ALPHA';
  },
  avatarInit(value: unknown): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  showConfirm(title: string, body: string, onConfirm: () => void): void {
    const w = winAny();
    if (typeof w.showConfirm === 'function') w.showConfirm(title, body, onConfirm);
  }
};

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
    const db = legacy.getDb();
    if (!db) return;

    const currentG = legacy.getActiveGuild();
    const membersQ = db.from('guild_members').select('pseudo').eq('guild', currentG).order('pseudo', { ascending: true });
    const sanctionsQ = db.from('sanctions').select('*').eq('guild', currentG).order('created_at', { ascending: false });

    const [membersRes, res] = await Promise.all([membersQ, sanctionsQ]);

    const datalist = document.getElementById('member-list-datalist');
    if (datalist && membersRes.data) {
      datalist.innerHTML = (membersRes.data as any[]).map((m) => '<option value="' + legacy.esc(m.pseudo) + '">').join('');
    }

    this.sanctions = (res.data || []) as SanctionRow[];
    this.render();
  }

  /** Attach the form submit + language-change listeners (legacy parse-time init). */
  public init(): void {
    const w = winAny();
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
          const db = legacy.getDb();
          if (!db) return;
          const currentG = legacy.getActiveGuild();
          const res = await db.from('sanctions').insert([{ guild: currentG, pseudo, comment }]).select();
          if (res.error) throw res.error;

          pseudoInput.value = '';
          commentInput.value = '';
          legacy.showToast(legacy.t('toast_sanction_added'), 'success');
          await this.load();
          this.checkRecidivist(pseudo);
        } catch (err: any) {
          legacy.showToast(err.message, 'error');
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
    w.addEventListener('rad-lang-change', this.langChangeHandler);
  }

  public destroy(): void {
    if (this.langChangeHandler) {
      winAny().removeEventListener('rad-lang-change', this.langChangeHandler);
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
      list.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + legacy.t('empty_sanctions') + '</div></div>';
      return;
    }

    let html = '<div class="gm-sanction-list">';
    const locale = 'en-GB';

    this.sanctions.forEach((s) => {
      const dateStr = new Date(s.created_at as string).toLocaleDateString(locale, {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      } as any);
      const author = s.created_by || '-';
      const initial = legacy.avatarInit(s.pseudo);
      html +=
        '<div class="gm-sanction-row">' +
          '<div class="gm-row" style="gap:.5rem;">' +
            '<div class="gm-avatar">' + legacy.esc(initial) + '</div>' +
            '<strong>' + legacy.esc(s.pseudo) + '</strong>' +
          '</div>' +
          '<div class="gm-sanction-comment">"' + legacy.esc(s.comment) + '"</div>' +
          '<div class="gm-sanction-meta">' +
            legacy.t('sanction_by') + ' <strong style="color: var(--accent);">' + legacy.esc(author) + '</strong> · ' + dateStr +
          '</div>' +
          '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm sanction-delete-btn" data-id="' + s.id + '" title="' + legacy.t('delete_title') + '" style="color: var(--danger);">' +
            '<i class="ph ph-trash"></i>' +
          '</button>' +
        '</div>';
    });
    html += '</div>';
    list.innerHTML = html;

    list.querySelectorAll('.sanction-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id') || '';
        legacy.showConfirm(
          legacy.t('confirm_delete_sanction_title'),
          legacy.t('confirm_delete_sanction_body'),
          () => { void this.deleteSanction(id); }
        );
      });
    });
  }

  private checkRecidivist(pseudo: string): void {
    const count = this.sanctions.filter((s) => s.pseudo === pseudo).length;
    if (count >= 3) {
      setTimeout(() => {
        legacy.showConfirm(
          legacy.t('alert_recidivist'),
          '<strong>' + legacy.esc(pseudo) + '</strong> : ' + count + ' ' + legacy.t('nav_sanctions'),
          () => { /* informational */ }
        );
      }, 500);
    }
  }

  private async deleteSanction(id: string): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    try {
      const res = await db.from('sanctions').delete().eq('id', id);
      if (res.error) throw res.error;
      await this.load();
      legacy.showToast(legacy.t('toast_sanction_deleted'), 'success');
    } catch (err: any) {
      legacy.showToast(err.message, 'error');
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_SANCTIONS` at cutover). */
export const sanctionsView = new SanctionsView();

export default sanctionsView;
