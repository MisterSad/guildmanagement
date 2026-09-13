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
    const g = gm();
    if (g && typeof g.escapeHTML === 'function') return g.escapeHTML(value);
    return value === null || value === undefined ? '' : String(value);
  },
  fmt(num: unknown): string {
    const g = gm();
    return g && typeof g.formatNumber === 'function' ? g.formatNumber(num) : String(num ?? '');
  },
  getWeekStart(): string {
    const g = gm();
    return g && typeof g.getWeekStart === 'function' ? g.getWeekStart() : '';
  },
  getPrevWeekStart(week: string): string {
    const g = gm();
    if (g && typeof g.getPrevWeekStart === 'function') return g.getPrevWeekStart(week);
    const d = new Date(week + 'T12:00:00Z');
    if (isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  },
  getActiveGuild(): string {
    const g = gm();
    return g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : 'ALPHA';
  },
  avatarInit(value: unknown): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  attachNumberFormatter(input: unknown): void {
    const g = gm();
    if (g && typeof g.attachNumberFormatter === 'function') g.attachNumberFormatter(input);
  },
  parseNumber(value: unknown): number {
    const g = gm();
    return g && typeof g.parseNumber === 'function' ? g.parseNumber(value) : (parseInt(String(value).replace(/[^0-9]/g, ''), 10) || 0);
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  fetchGuildMembers(): void {
    const g = gm();
    if (g && typeof g.fetchGuildMembers === 'function') g.fetchGuildMembers();
  }
};

export class GloryView {
  public async load(): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const week = legacy.getWeekStart();
    try {
      const prevWeek = legacy.getPrevWeekStart(week);
      const currentG = legacy.getActiveGuild();

      const [membersRes, currRes, prevRes] = await Promise.all([
        db.from('guild_members').select('pseudo').eq('guild', currentG).order('pseudo', { ascending: true }),
        db.from('event_participants').select('pseudo,score').eq('guild', currentG).eq('event_name', 'Glory').eq('week_start', week),
        db.from('event_participants').select('pseudo,score').eq('guild', currentG).eq('event_name', 'Glory').eq('week_start', prevWeek)
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
      area.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + legacy.t('empty_members') + '</div></div>';
      return;
    }

    const totalGlory = Object.values(currMap).reduce((s: number, v: any) => s + (v || 0), 0);

    let html =
      '<div class="gm-stat-grid" style="margin-bottom: 1.5rem;">' +
        '<div class="gm-stat-tile stat-theme-lime">' +
          '<div class="gm-task-icon-squircle"><i class="ph ph-users"></i></div>' +
          '<div class="gm-stat-label">' + legacy.t('event_total') + '</div>' +
          '<div class="gm-stat-val">' + legacy.fmt(members.length) + '</div>' +
          '<div class="gm-stat-meta">Active Members Tracked</div>' +
        '</div>' +
        '<div class="gm-stat-tile stat-theme-mint">' +
          '<div class="gm-task-icon-squircle"><i class="ph ph-trophy"></i></div>' +
          '<div class="gm-stat-label">' + legacy.t('glory_total') + '</div>' +
          '<div class="gm-stat-val total-glory-val">' + legacy.fmt(totalGlory) + '</div>' +
          '<div class="gm-stat-meta">Guild Total This Week</div>' +
        '</div>' +
      '</div>' +
      '<div class="gm-section-head" style="margin-bottom: 1rem; flex-wrap: wrap;">' +
        '<div class="gm-section-title"><i class="ph ph-list-numbers"></i> Members Glory Log</div>' +
        '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
          '<i class="ph ph-magnifying-glass gm-icon"></i>' +
          '<input type="text" class="gm-input glory-search-input" placeholder="' + legacy.t('search_placeholder') + '">' +
          '<button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search" tabindex="-1"><span class="material-symbols-rounded">cancel</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="gm-table-wrap">' +
      '<div class="gm-table-scroll">' +
      '<table class="gm-table gm-resp-table"><thead><tr>' +
        '<th>' + legacy.t('col_member') + '</th>' +
        '<th class="gm-right">' + legacy.t('glory_prev_week') + '</th>' +
        '<th class="gm-right">' + legacy.t('glory_input') + '</th>' +
        '<th class="gm-right">' + legacy.t('glory_evolution_pct') + '</th>' +
      '</tr></thead><tbody>';

    members.forEach((pseudo) => {
      const curr = currMap[pseudo] != null ? currMap[pseudo] : '';
      const prev = prevMap[pseudo] != null ? prevMap[pseudo] : null;
      const initial = legacy.avatarInit(pseudo);

      html +=
        '<tr class="participant-row" data-pseudo="' + legacy.esc(pseudo) + '">' +
          '<td data-label="' + legacy.t('col_member') + '">' +
            '<div class="gm-member-id">' +
              '<div class="gm-avatar gm-avatar-squircle">' + legacy.esc(initial) + '</div>' +
              '<strong>' + legacy.esc(pseudo) + '</strong>' +
            '</div>' +
          '</td>' +
          '<td class="gm-right gm-num gm-dim glory-prev-val" data-label="' + legacy.t('glory_prev_week') + '">' +
            (prev !== null ? legacy.fmt(prev) : '-') +
          '</td>' +
          '<td class="gm-right" data-label="' + legacy.t('glory_input') + '">' +
            '<div class="glory-input-wrapper" style="position:relative; display:inline-flex; align-items:center;">' +
              '<input type="text" inputmode="numeric" class="gm-glory-input glory-input"' +
                ' value="' + (curr !== '' ? legacy.fmt(curr) : '') + '" placeholder="0"' +
                ' data-pseudo="' + legacy.esc(pseudo) + '"' +
                ' data-prev="' + (prev !== null ? prev : '') + '">' +
              '<i class="ph ph-circle-notch ph-spin saving-icon hidden" style="position:absolute; right:.6rem;"></i>' +
            '</div>' +
          '</td>' +
          '<td class="gm-right glory-pct-cell" data-label="' + legacy.t('glory_evolution_pct') + '">' +
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
      legacy.attachNumberFormatter(inp);
      let timer: ReturnType<typeof setTimeout> | undefined;
      inp.addEventListener('input', () => {
        const prev = inp.getAttribute('data-prev');
        const curr = legacy.parseNumber(inp.value);
        const row = inp.closest('tr');

        const currCell = row ? row.querySelector('.glory-curr-val') : null;
        if (currCell) {
          currCell.innerHTML = curr !== null ? '<span>' + legacy.fmt(curr) + '</span>' : '<span class="glory-na">-</span>';
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
    const c = typeof curr === 'number' ? curr : legacy.parseNumber(curr);
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
      const n = legacy.parseNumber((el as HTMLInputElement).value);
      total += (n || 0);
    });
    const valSpan = area.querySelector('.total-glory-val');
    if (valSpan) valSpan.textContent = legacy.fmt(total);
  }

  private async saveGlory(pseudo: string, value: any, week: string, icon: Element | null): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    try {
      const currentG = legacy.getActiveGuild();
      const scoreVal = (value === null || value === '') ? 0 : (typeof value === 'number' ? value : (legacy.parseNumber(value) || 0));
      const rpcRes = await db.rpc('gm_upsert_player_glory', {
        p_guild: currentG,
        p_pseudo: pseudo,
        p_week_start: week,
        p_glory: scoreVal
      });
      if (rpcRes && rpcRes.error) throw rpcRes.error;
      // The RPC reports logical failures (permission_denied, ...) in its result
      // row rather than as a transport error: surface them.
      const row = rpcRes && rpcRes.data ? (Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data) : null;
      if (!row || !row.ok) throw new Error((row && row.error) || 'save_failed');
      if (icon) icon.classList.add('hidden');
      legacy.fetchGuildMembers();
    } catch (err: any) {
      console.error('saveGlory', err);
      if (icon) icon.classList.add('hidden');
      legacy.showToast(legacy.t('toast_err_generic') + ' Glory' + (err && err.message ? ' (' + err.message + ')' : ''), 'error');
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_GLORY` at cutover). */
export const gloryView = new GloryView();

export default gloryView;
