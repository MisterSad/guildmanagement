/**
 * src/modules/glory/views/GloryView.ts
 *
 * Strangler Phase 1 port of the root `glory.js` weekly Glory tracker. Glory is
 * keyed by week_start only (no session notion): renders the member log with
 * previous-week comparison, debounced upsert via `gm_upsert_player_glory`, and
 * live guild-total / evolution-badge updates.
 *
 * This module never assigns `window.GM_GLORY` (bridge added at cutover).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { fetchGloryMembers, fetchGloryWeekScores, upsertPlayerGlory } from '../glory.service';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild } from '../../../core/auth/roles';
import { showToast } from '../../../core/dom/toast';
import { attachNumberFormatter } from '../../../core/dom/ui';
import { t } from '../../../core/i18n/i18n';
import { getPrevWeekStart, getWeekStart } from '../../../core/utils/date';
import { avatarInit, escapeHTML, formatNumber, parseNumber } from '../../../core/utils/text';

export class GloryView {
  public async load(): Promise<void> {
    const db = getClient();
    if (!db) return;
    const week = getWeekStart();
    try {
      const prevWeek = getPrevWeekStart(week);
      const currentG = getActiveGuild();

      const [membersRes, currRes, prevRes] = await Promise.all([
        fetchGloryMembers(db, currentG),
        fetchGloryWeekScores(db, currentG, week),
        fetchGloryWeekScores(db, currentG, prevWeek)
      ]);

      const members: string[] = ((membersRes.data || []) as any[]).map((m) => m.pseudo);
      const currMap: Record<string, any> = {};
      const prevMap: Record<string, any> = {};
      ((currRes.data || []) as any[]).forEach((r) => {
        if (r.score != null || currMap[r.pseudo] == null) currMap[r.pseudo] = r.score;
      });
      ((prevRes.data || []) as any[]).forEach((r) => {
        if (r.score != null || prevMap[r.pseudo] == null) prevMap[r.pseudo] = r.score;
      });

      members.sort((a, b) => {
        let valA = prevMap[a] != null ? (typeof prevMap[a] === 'number' ? prevMap[a] : parseInt(prevMap[a], 10)) : -1;
        let valB = prevMap[b] != null ? (typeof prevMap[b] === 'number' ? prevMap[b] : parseInt(prevMap[b], 10)) : -1;
        if (isNaN(valA)) valA = -1;
        if (isNaN(valB)) valB = -1;
        if (valB !== valA) return valB - valA;
        return a.localeCompare(b);
      });

      this.render(members, currMap, prevMap, week);
    } catch (err) {
      console.error('loadGlory error:', err);
      this.render([], {}, {}, week);
    }
  }

  private render(members: string[], currMap: Record<string, any>, prevMap: Record<string, any>, week: string): void {
    const area = document.querySelector('#event-glory .event-participants-area');
    if (!area) return;

    if (!members.length) {
      area.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
      return;
    }

    const totalGlory = Object.values(currMap).reduce((s: number, v: any) => s + (v || 0), 0);

    let html =
      '<div class="gm-stat-grid" style="margin-bottom: 1.5rem;">' +
        '<div class="gm-stat-tile stat-theme-lime">' +
          '<div class="gm-task-icon-squircle"><i class="ph ph-users"></i></div>' +
          '<div class="gm-stat-label">' + t('event_total') + '</div>' +
          '<div class="gm-stat-val">' + formatNumber(members.length) + '</div>' +
          '<div class="gm-stat-meta">Active Members Tracked</div>' +
        '</div>' +
        '<div class="gm-stat-tile stat-theme-mint">' +
          '<div class="gm-task-icon-squircle"><i class="ph ph-trophy"></i></div>' +
          '<div class="gm-stat-label">' + t('glory_total') + '</div>' +
          '<div class="gm-stat-val total-glory-val">' + formatNumber(totalGlory) + '</div>' +
          '<div class="gm-stat-meta">Guild Total This Week</div>' +
        '</div>' +
      '</div>' +
      '<div class="gm-section-head" style="margin-bottom: 1rem; flex-wrap: wrap;">' +
        '<div class="gm-section-title"><i class="ph ph-list-numbers"></i> Members Glory Log</div>' +
        '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
          '<i class="ph ph-magnifying-glass gm-icon"></i>' +
          '<input type="text" class="gm-input glory-search-input" placeholder="' + t('search_placeholder') + '">' +
          '<button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search" tabindex="-1"><i class="ph ph-x-circle"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="gm-table-wrap">' +
      '<div class="gm-table-scroll">' +
      '<table class="gm-table gm-resp-table"><thead><tr>' +
        '<th>' + t('col_member') + '</th>' +
        '<th class="gm-right">' + t('glory_prev_week') + '</th>' +
        '<th class="gm-right">' + t('glory_input') + '</th>' +
        '<th class="gm-right">' + t('glory_evolution_pct') + '</th>' +
      '</tr></thead><tbody>';

    members.forEach((pseudo) => {
      const curr = currMap[pseudo] != null ? currMap[pseudo] : '';
      const prev = prevMap[pseudo] != null ? prevMap[pseudo] : null;
      const initial = avatarInit(pseudo);

      html +=
        '<tr class="participant-row" data-pseudo="' + escapeHTML(pseudo) + '">' +
          '<td data-label="' + t('col_member') + '">' +
            '<div class="gm-member-id">' +
              '<div class="gm-avatar gm-avatar-squircle">' + escapeHTML(initial) + '</div>' +
              '<strong>' + escapeHTML(pseudo) + '</strong>' +
            '</div>' +
          '</td>' +
          '<td class="gm-right gm-num gm-dim glory-prev-val" data-label="' + t('glory_prev_week') + '">' +
            (prev !== null ? formatNumber(prev) : '-') +
          '</td>' +
          '<td class="gm-right" data-label="' + t('glory_input') + '">' +
            '<div class="glory-input-wrapper" style="position:relative; display:inline-flex; align-items:center;">' +
              '<input type="text" inputmode="numeric" class="gm-glory-input glory-input"' +
                ' value="' + (curr !== '' ? formatNumber(curr) : '') + '" placeholder="0"' +
                ' data-pseudo="' + escapeHTML(pseudo) + '"' +
                ' data-prev="' + (prev !== null ? prev : '') + '">' +
              '<i class="ph ph-circle-notch ph-spin saving-icon hidden" style="position:absolute; right:.6rem;"></i>' +
            '</div>' +
          '</td>' +
          '<td class="gm-right glory-pct-cell" data-label="' + t('glory_evolution_pct') + '">' +
            this.buildEvolutionPctBadge(curr, prev) +
          '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div></div>';
    area.innerHTML = html;

    const searchInput = area.querySelector('.glory-search-input') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.toLowerCase();
        area.querySelectorAll('.participant-row').forEach((row) => {
          const pseudo = (row.getAttribute('data-pseudo') || '').toLowerCase();
          (row as HTMLElement).style.display = pseudo.indexOf(q) !== -1 ? '' : 'none';
        });
      });
    }

    area.querySelectorAll('.glory-input').forEach((el) => {
      const inp = el as HTMLInputElement;
      attachNumberFormatter(inp);
      let timer: ReturnType<typeof setTimeout> | undefined;
      inp.addEventListener('input', () => {
        const prev = inp.getAttribute('data-prev');
        const curr = parseNumber(inp.value);
        const row = inp.closest('tr');

        const currCell = row ? row.querySelector('.glory-curr-val') : null;
        if (currCell) {
          currCell.innerHTML = curr !== null ? '<span>' + formatNumber(curr) + '</span>' : '<span class="glory-na">-</span>';
        }

        const pctCell = row ? row.querySelector('.glory-pct-cell') : null;
        if (pctCell) {
          pctCell.innerHTML = this.buildEvolutionPctBadge(curr, prev === '' ? null : parseInt(prev as string, 10));
        }

        this.updateTotal(area);

        const icon = row ? row.querySelector('.saving-icon') : null;
        if (icon) icon.classList.remove('hidden');

        clearTimeout(timer);
        timer = setTimeout(() => {
          void this.saveGlory(inp.getAttribute('data-pseudo') || '', curr, week, icon);
        }, 700);
      });
    });
  }

  private buildEvolutionPctBadge(curr: any, prev: any): string {
    if (curr === null || curr === '' || prev === null || prev === 0) return '<span class="gm-dim">-</span>';
    const c = typeof curr === 'number' ? curr : parseNumber(curr);
    const p = typeof prev === 'number' ? prev : parseInt(prev, 10);
    if (c === null || isNaN(p) || p === 0) return '<span class="gm-dim">-</span>';
    const diff = c - p;
    const pct = (diff / p) * 100;

    const cls = pct > 0 ? 'gm-chip-success' : pct < 0 ? 'gm-chip-danger' : '';
    const sign = pct > 0 ? '+' : '';
    return '<span class="gm-chip ' + cls + '" style="font-family: var(--font-display); font-weight: 700; font-size: var(--fs-sm); padding: 2px 10px; border-radius: var(--radius-pill);">' + sign + pct.toFixed(1) + '%</span>';
  }

  private updateTotal(area: Element): void {
    let total = 0;
    area.querySelectorAll('.glory-input').forEach((el) => {
      const n = parseNumber((el as HTMLInputElement).value);
      total += (n || 0);
    });
    const valSpan = area.querySelector('.total-glory-val');
    if (valSpan) valSpan.textContent = formatNumber(total);
  }

  private async saveGlory(pseudo: string, value: any, week: string, icon: Element | null): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      const currentG = getActiveGuild();
      const scoreVal = (value === null || value === '') ? 0 : (typeof value === 'number' ? value : (parseNumber(value) || 0));
      const rpcRes = await upsertPlayerGlory(db, currentG, pseudo, week, scoreVal);
      if (rpcRes && rpcRes.error) throw rpcRes.error;
      // The RPC reports logical failures (permission_denied, ...) in its result
      // row rather than as a transport error: surface them.
      const row = rpcRes && rpcRes.data ? (Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data) : null;
      if (!row || !row.ok) throw new Error((row && row.error) || 'save_failed');
      if (icon) icon.classList.add('hidden');
      // A `window.GM.fetchGuildMembers()` call used to follow here. Nothing ever
      // installed that member (the roster loader lives on GM_MEMBERS), so it was
      // a no-op and was dropped rather than turned into a new roster refetch.
    } catch (err: any) {
      console.error('saveGlory', err);
      if (icon) icon.classList.add('hidden');
      showToast(t('toast_err_generic') + ' Glory' + (err && err.message ? ' (' + err.message + ')' : ''), 'error');
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_GLORY` at cutover). */
export const gloryView = new GloryView();

export default gloryView;
