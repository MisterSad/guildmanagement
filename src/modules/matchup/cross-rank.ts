/**
 * src/modules/matchup/cross-rank.ts
 *
 * ES Module TypeScript implementation of Cross-Guild Draft Ranking & Mercato.
 * Super Admin consolidated view across all servers and guilds.
 */

import { getSupabaseClient, escapeHTML } from '../../core/api/supabase';
import { t } from '../../core/i18n/i18n';
import { logger } from '../../core/logger/logger';

export interface CrossRankPlayer {
  pseudo: string;
  guild: string;
  server_number?: string | null;
  overall_power: number;
  svs_rate?: number | null;
  svs_total?: number;
  gvg_rate?: number | null;
  gvg_total?: number;
  shadow_rate?: number | null;
  shadow_total?: number;
  dtr_rate?: number | null;
  dtr_total?: number;
  arms_rate?: number | null;
  arms_total?: number;
  global_rate?: number | null;
}

export class CrossRankView {
  private static state = {
    rows: [] as CrossRankPlayer[],
    sortKey: 'global' as string,
    sortDesc: true,
    query: '',
    guild: 'ALL',
    server: 'ALL',
  };

  public static async load(): Promise<void> {
    const container = document.getElementById('cross-rank-container');
    if (!container) return;

    this.state.query = '';
    this.state.guild = 'ALL';
    this.state.server = 'ALL';
    this.state.sortKey = 'global';
    this.state.sortDesc = true;

    container.innerHTML = `
      <div class="gm-empty" style="padding:2rem;">
        <i class="ph-duotone ph-arrows-clockwise gm-icon" style="animation: spin 1s linear infinite;"></i>
        <div class="gm-empty-title">Loading cross-guild draft data...</div>
      </div>`;

    const supabase = getSupabaseClient();
    if (!supabase) return;

    try {
      const { data, error } = await supabase.rpc('gm_cross_guild_ranking', {
        p_weeks: 8,
        p_server_number: null,
      });

      if (error) {
        logger.error('Failed gm_cross_guild_ranking', error);
        container.innerHTML = `
          <div class="gm-empty" style="padding:2rem; color:var(--error);">
            <i class="ph-duotone ph-warning-circle gm-icon"></i>
            <div class="gm-empty-title">Failed to load draft data</div>
            <p style="font-size:0.85rem; color:var(--text-muted);">${escapeHTML(error.message)}</p>
          </div>`;
        return;
      }

      this.state.rows = (data || []) as CrossRankPlayer[];
      this.render();
    } catch (err) {
      logger.error('Error loading cross-rank data', err);
    }
  }

  public static render(): void {
    const container = document.getElementById('cross-rank-container');
    if (!container) return;

    if (this.state.rows.length === 0) {
      container.innerHTML = `
        <div class="gm-empty" style="padding:3rem 1rem;">
          <i class="ph-duotone ph-users-three gm-icon"></i>
          <div class="gm-empty-title">No player data available across guilds</div>
        </div>`;
      return;
    }

    // Render table
    let filtered = [...this.state.rows];

    if (this.state.guild !== 'ALL') {
      filtered = filtered.filter((r) => r.guild === this.state.guild);
    }
    if (this.state.server !== 'ALL') {
      filtered = filtered.filter((r) => r.server_number === this.state.server);
    }
    if (this.state.query.trim()) {
      const q = this.state.query.toLowerCase();
      filtered = filtered.filter(
        (r) => r.pseudo.toLowerCase().includes(q) || r.guild.toLowerCase().includes(q)
      );
    }

    filtered.sort((a, b) => {
      let va = 0;
      let vb = 0;
      if (this.state.sortKey === 'global') {
        va = a.global_rate || 0;
        vb = b.global_rate || 0;
      } else if (this.state.sortKey === 'power') {
        va = a.overall_power || 0;
        vb = b.overall_power || 0;
      }
      return this.state.sortDesc ? vb - va : va - vb;
    });

    let rowsHtml = '';
    filtered.forEach((p, idx) => {
      const globalRate = p.global_rate != null ? `${p.global_rate}%` : '-';
      const powerStr = (p.overall_power || 0).toLocaleString();

      rowsHtml += `
        <tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:0.6rem 0.75rem; font-weight:700; color:var(--text-muted);">${idx + 1}</td>
          <td style="padding:0.6rem 0.75rem; font-weight:600; color:var(--text-primary);">${escapeHTML(p.pseudo)}</td>
          <td style="padding:0.6rem 0.75rem;"><span class="gm-badge gm-badge-blue">${escapeHTML(p.guild)}</span></td>
          <td style="padding:0.6rem 0.75rem; color:var(--text-secondary);">${escapeHTML(p.server_number || '-')}</td>
          <td style="padding:0.6rem 0.75rem; text-align:right; font-variant-numeric:tabular-nums;">${powerStr}</td>
          <td style="padding:0.6rem 0.75rem; text-align:right; font-weight:700; color:var(--accent);">${globalRate}</td>
        </tr>`;
    });

    container.innerHTML = `
      <div style="margin-bottom:1rem; display:flex; gap:0.75rem; flex-wrap:wrap;">
        <input type="text" id="cross-rank-search" class="gm-input" placeholder="Search player or guild..." value="${escapeHTML(this.state.query)}" style="flex:2; min-width:200px;">
      </div>
      <table class="gm-table" style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom: 2px solid var(--border-color); text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted);">
            <th style="padding:0.5rem 0.75rem;">#</th>
            <th style="padding:0.5rem 0.75rem;">Player</th>
            <th style="padding:0.5rem 0.75rem;">Guild</th>
            <th style="padding:0.5rem 0.75rem;">Server</th>
            <th style="padding:0.5rem 0.75rem; text-align:right;">Power</th>
            <th style="padding:0.5rem 0.75rem; text-align:right;">Weighted Rate</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;

    const searchInput = document.getElementById('cross-rank-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.state.query = searchInput.value;
        this.render();
      });
    }
  }
}
