/**
 * cross-rank.ts — Cross-Guild Draft Ranking & Mercato ("Draft" tab, superadmin).
 * Inter-Server Migration Scouting & Combat Scoring Engine.
 * All scoring metrics normalized on a clean 0 to 100 scale:
 * - Draft Score (0-100%): Master composite index synthesized from all component scores.
 * - Day 6 PvP (0-100%): Combat battle rating based on SvS/GvG Day 6 battle points (2x doubled factor) and battle presence.
 * - Shadowfront (0-100%): Priority 20v20 guild coordination attendance rate.
 * - Glory (0-100%): Glory score based on accumulated points and weekly consistency.
 * - SvS & GvG (0-100%): Attendance rates across active campaigns.
 * - Server Filtering: Fast target-server isolation for migration events.
 */

import { getSupabaseClient, escapeHTML } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export interface CrossRankPlayer {
  pseudo: string;
  guild: string;
  server_number?: string | null;
  power?: number;
  overall_power?: number;
  draft_score?: number | null;
  day6_score?: number | null;
  day6_pvp_score?: number | null;
  svs_attended?: number;
  svs_total?: number;
  svs_rate?: number | null;
  svs_avg_prep?: number | null;
  svs_avg_pvp?: number | null;
  gvg_attended?: number;
  gvg_total?: number;
  gvg_rate?: number | null;
  gvg_avg_prep?: number | null;
  gvg_avg_pvp?: number | null;
  shadow_attended?: number;
  shadow_total?: number;
  shadow_rate?: number | null;
  dtr_attended?: number;
  dtr_total?: number;
  dtr_rate?: number | null;
  arms_attended?: number;
  arms_total?: number;
  arms_rate?: number | null;
  glory_score?: number | null;
  glory_total?: number | null;
  glory_attended?: number;
  glory_total_weeks?: number;
  glory_rate?: number | null;
  global_attended?: number;
  global_total?: number;
  global_rate?: number | null;
  scouting_tier?: string | null;
}

export function computeDay6Score(p: CrossRankPlayer): number | null {
  if (p.day6_score != null) return p.day6_score;
  const svsRate = p.svs_rate ?? 0;
  const gvgRate = p.gvg_rate ?? 0;
  const attRate = (svsRate + gvgRate) / 2;
  const rawPvp = p.day6_pvp_score ?? (((p.svs_avg_pvp ?? 0) * 2) + ((p.gvg_avg_pvp ?? 0) * 2));
  if (rawPvp > 0) {
    const pvpPct = Math.min(100, (rawPvp / 20000000) * 100);
    return Math.round((attRate * 0.4 + pvpPct * 0.6) * 10) / 10;
  }
  if (attRate > 0) return Math.round((attRate * 0.5) * 10) / 10;
  return (p.svs_total || p.gvg_total) ? 0 : null;
}

export function computeGloryScore(p: CrossRankPlayer): number | null {
  if (p.glory_score != null) return p.glory_score;
  const glRate = p.glory_rate ?? 0;
  const rawGl = p.glory_total ?? 0;
  if (rawGl > 0) {
    const glPct = Math.min(100, (rawGl / 500000) * 100);
    return Math.round((glRate * 0.5 + glPct * 0.5) * 10) / 10;
  }
  if (glRate > 0) return Math.round((glRate * 0.5) * 10) / 10;
  return (p.glory_total_weeks || p.glory_total) ? 0 : null;
}

export function computeDraftScore(p: CrossRankPlayer): number | null {
  if (p.draft_score != null) return p.draft_score;

  const sf = p.shadow_rate ?? 0;
  const d6 = computeDay6Score(p) ?? 0;
  const svs = p.svs_rate ?? 0;
  const gvg = p.gvg_rate ?? 0;
  const gl = computeGloryScore(p) ?? 0;
  const glob = p.global_rate ?? 0;

  const hasAnyTotal =
    (p.global_total ?? 0) > 0 ||
    (p.shadow_total ?? 0) > 0 ||
    (p.svs_total ?? 0) > 0 ||
    (p.gvg_total ?? 0) > 0 ||
    (p.glory_total_weeks ?? 0) > 0;

  if (!hasAnyTotal) return null;

  // Master Composite Draft Score:
  // 30% Shadowfront attendance (Priority 20v20 pillar)
  // 25% Day 6 PvP combat rating (2x doubled battle weight)
  // 15% SvS attendance (Days 1-5)
  // 15% GvG attendance (Days 1-5)
  // 10% Glory score (Accumulated points & presence)
  // 5% Other events (DTR & Arms Race)
  const score = (sf * 0.30) + (d6 * 0.25) + (svs * 0.15) + (gvg * 0.15) + (gl * 0.10) + (glob * 0.05);
  return Math.round(score * 10) / 10;
}

export function getPlayerPower(p: CrossRankPlayer): number {
  return p.overall_power ?? p.power ?? 0;
}

export class CrossRankView {
  private static state = {
    rows: [] as CrossRankPlayer[],
    sortKey: 'draft_score' as string,
    sortDesc: true,
    query: '',
    guild: 'ALL',
    server: 'ALL',
    preset: 'ALL' as 'ALL' | 'DAY6' | 'SHADOW' | 'GLORY' | 'ELITE',
  };

  public static async load(): Promise<void> {
    const container = document.getElementById('cross-rank-container');
    if (!container) return;

    this.state.query = '';
    this.state.guild = 'ALL';
    this.state.server = 'ALL';
    this.state.preset = 'ALL';
    this.state.sortKey = 'draft_score';
    this.state.sortDesc = true;

    container.innerHTML = `
      <div class="gm-empty" style="padding:2.5rem;">
        <i class="ph-duotone ph-arrows-clockwise gm-icon" style="animation: spin 1s linear infinite;"></i>
        <div class="gm-empty-title">Loading cross-guild migration scouting data...</div>
      </div>`;

    const supabase = getSupabaseClient();
    if (!supabase) return;

    try {
      const { data, error } = await supabase.rpc('gm_cross_guild_ranking');

      if (error) {
        logger.error('Failed gm_cross_guild_ranking', error);
        container.innerHTML = `
          <div class="gm-empty" style="padding:2rem; color:var(--error);">
            <i class="ph-duotone ph-warning-circle gm-icon"></i>
            <div class="gm-empty-title">Failed to load draft scouting data</div>
            <p style="font-size:0.85rem; color:var(--text-muted);">${escapeHTML(error.message)}</p>
          </div>`;
        return;
      }

      this.state.rows = ((data || []) as CrossRankPlayer[]).filter(
        (r) => r.guild !== 'DEMO'
      );
      this.render();
    } catch (err) {
      logger.error('Error loading cross-rank data', err);
    }
  }

  public static render(): void {
    const container = document.getElementById('cross-rank-container');
    if (!container) return;

    const q = this.state.query.trim().toLowerCase();
    const filtered = this.state.rows.filter((r) => {
      if (this.state.guild !== 'ALL' && r.guild !== this.state.guild) return false;
      const sVal = String(r.server_number || '');
      if (this.state.server !== 'ALL' && sVal !== this.state.server) return false;

      const d6 = computeDay6Score(r);
      const gl = computeGloryScore(r);
      const ds = computeDraftScore(r);

      if (this.state.preset === 'DAY6' && (d6 == null || d6 < 40)) return false;
      if (this.state.preset === 'SHADOW' && (r.shadow_rate == null || r.shadow_rate < 50)) return false;
      if (this.state.preset === 'GLORY' && (gl == null || gl < 40)) return false;
      if (this.state.preset === 'ELITE' && (ds == null || ds < 75)) return false;

      if (!q) return true;
      const pseudo = (r.pseudo || '').toLowerCase();
      const guild = (r.guild || '').toLowerCase();
      const server = sVal.toLowerCase();
      const formattedServer = `#${sVal}`.toLowerCase();
      return (
        pseudo.includes(q) ||
        guild.includes(q) ||
        server.includes(q) ||
        formattedServer.includes(q)
      );
    });

    // Multi-column sorting
    filtered.sort((a, b) => {
      let va: number | string | null = null;
      let vb: number | string | null = null;

      if (this.state.sortKey === 'pseudo') {
        const cmp = a.pseudo.localeCompare(b.pseudo);
        return this.state.sortDesc ? -cmp : cmp;
      }
      if (this.state.sortKey === 'server') {
        const cmp = String(a.server_number || '').localeCompare(String(b.server_number || ''));
        if (cmp !== 0) return this.state.sortDesc ? -cmp : cmp;
        return getPlayerPower(b) - getPlayerPower(a);
      }
      if (this.state.sortKey === 'guild') {
        const cmp = a.guild.localeCompare(b.guild);
        if (cmp !== 0) return this.state.sortDesc ? -cmp : cmp;
        return getPlayerPower(b) - getPlayerPower(a);
      }
      if (this.state.sortKey === 'power') {
        va = getPlayerPower(a);
        vb = getPlayerPower(b);
      } else if (this.state.sortKey === 'day6' || this.state.sortKey === 'day6_score') {
        va = computeDay6Score(a);
        vb = computeDay6Score(b);
      } else if (this.state.sortKey === 'glory' || this.state.sortKey === 'glory_score') {
        va = computeGloryScore(a);
        vb = computeGloryScore(b);
      } else if (this.state.sortKey === 'shadow_rate') {
        va = a.shadow_rate ?? null;
        vb = b.shadow_rate ?? null;
      } else {
        va = computeDraftScore(a);
        vb = computeDraftScore(b);
      }

      if (va === null && vb === null) return getPlayerPower(b) - getPlayerPower(a);
      if (va === null) return 1;
      if (vb === null) return -1;

      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return this.state.sortDesc ? vb - va : va - vb;
      }

      // Tie breaker 1: Day 6 score
      const aDay6 = computeDay6Score(a) ?? 0;
      const bDay6 = computeDay6Score(b) ?? 0;
      if (aDay6 !== bDay6) return bDay6 - aDay6;

      // Tie breaker 2: Power
      return getPlayerPower(b) - getPlayerPower(a);
    });

    const servers = Array.from(
      new Set(this.state.rows.map((r) => String(r.server_number || '')).filter(Boolean))
    ).sort();

    const guilds = Array.from(new Set(this.state.rows.map((r) => r.guild).filter(Boolean))).sort();

    let rowsHtml = '';
    filtered.forEach((p, idx) => {
      const draftScore = computeDraftScore(p);
      const draftScoreStr = draftScore != null ? `${Math.round(draftScore)}%` : '-';
      const day6Score = computeDay6Score(p);
      const day6Str = day6Score != null ? `${Math.round(day6Score)}%` : '-';
      const shadowRateStr = p.shadow_rate != null ? `${Math.round(p.shadow_rate)}%` : '-';
      const shadowRatio = p.shadow_total ? `${p.shadow_attended || 0}/${p.shadow_total}` : '';
      const gloryScore = computeGloryScore(p);
      const gloryStr = gloryScore != null ? `${Math.round(gloryScore)}%` : '-';
      const powerStr = getPlayerPower(p).toLocaleString();
      const serverStr = p.server_number ? `#${p.server_number}` : '-';

      let tierBadge = '';
      if (draftScore != null) {
        if (draftScore >= 80) {
          tierBadge = '<span class="gm-badge gm-badge-emerald" style="font-weight:800; font-size:0.68rem; margin-left:4px;">ELITE</span>';
        } else if (draftScore >= 60) {
          tierBadge = '<span class="gm-badge gm-badge-blue" style="font-weight:700; font-size:0.68rem; margin-left:4px;">WARRIOR</span>';
        }
      }

      rowsHtml += `
        <tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:0.45rem 0.5rem; font-weight:700; color:var(--text-muted); text-align:center;">${idx + 1}</td>
          <td style="padding:0.45rem 0.5rem; font-weight:600; color:var(--text-primary);">
            ${escapeHTML(p.pseudo)}
            ${tierBadge}
          </td>
          <td style="padding:0.45rem 0.5rem; text-align:center;">
            <span class="gm-badge" style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); font-weight:700; font-size:0.75rem;">
              ${escapeHTML(serverStr)}
            </span>
          </td>
          <td style="padding:0.45rem 0.5rem; text-align:center;">
            <span class="gm-badge gm-badge-blue">${escapeHTML(p.guild)}</span>
          </td>
          <td style="padding:0.45rem 0.5rem; text-align:right; font-variant-numeric:tabular-nums;">${powerStr}</td>
          <td style="padding:0.45rem 0.5rem; text-align:center; font-weight:800; color:var(--accent); font-variant-numeric:tabular-nums;">
            ${draftScoreStr}
          </td>
          <td style="padding:0.45rem 0.5rem; text-align:center; font-variant-numeric:tabular-nums; font-weight:700; color:#f87171;">
            ${day6Str}
          </td>
          <td style="padding:0.45rem 0.5rem; text-align:center; font-variant-numeric:tabular-nums;">
            <div style="font-weight:700; color:${(p.shadow_rate ?? 0) >= 50 ? 'var(--success)' : 'var(--text-secondary)'};">
              ${shadowRateStr}
            </div>
            ${shadowRatio ? `<div style="font-size:0.68rem; color:var(--text-muted);">${shadowRatio}</div>` : ''}
          </td>
          <td style="padding:0.45rem 0.5rem; text-align:center; font-variant-numeric:tabular-nums; font-weight:700; color:#fbbf24;">
            ${gloryStr}
          </td>
        </tr>`;
    });

    const isFiltered = this.state.guild !== 'ALL' || this.state.server !== 'ALL' || this.state.preset !== 'ALL' || !!this.state.query.trim();
    const countText = isFiltered
      ? `${filtered.length} of ${this.state.rows.length} candidates`
      : `${this.state.rows.length} candidates`;

    container.innerHTML = `
      <div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">
        <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center; margin-bottom:0.75rem;">
          <div class="gm-input-with-icon" style="flex:2; min-width:220px;">
            <i class="ph ph-magnifying-glass gm-icon"></i>
            <input type="text" id="cross-rank-search" class="gm-input" placeholder="Search candidate, server #, or guild..." value="${escapeHTML(this.state.query)}">
          </div>
          <select id="cross-rank-server" class="gm-input" style="flex:1; min-width:140px;">
            <option value="ALL">All Migration Servers</option>
            ${servers.map((s) => `<option value="${escapeHTML(s)}"${this.state.server === s ? ' selected' : ''}>Server #${escapeHTML(s)}</option>`).join('')}
          </select>
          <select id="cross-rank-guild" class="gm-input" style="flex:1; min-width:130px;">
            <option value="ALL">All Guilds</option>
            ${guilds.map((g) => `<option value="${escapeHTML(g)}"${this.state.guild === g ? ' selected' : ''}>${escapeHTML(g)}</option>`).join('')}
          </select>
          <span class="gm-dim" style="margin-left:auto; font-weight:600; font-size:0.88rem;">${escapeHTML(countText)}</span>
        </div>
        <!-- Scouting Presets -->
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
          <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Scouting Focus:</span>
          <button type="button" class="gm-btn gm-btn-sm ${this.state.preset === 'ALL' ? 'gm-btn-primary' : 'gm-btn-ghost'}" data-preset="ALL">All</button>
          <button type="button" class="gm-btn gm-btn-sm ${this.state.preset === 'DAY6' ? 'gm-btn-primary' : 'gm-btn-ghost'}" data-preset="DAY6">⚔️ Day 6 PvP (≥40%)</button>
          <button type="button" class="gm-btn gm-btn-sm ${this.state.preset === 'SHADOW' ? 'gm-btn-primary' : 'gm-btn-ghost'}" data-preset="SHADOW">👻 Shadowfront (≥50%)</button>
          <button type="button" class="gm-btn gm-btn-sm ${this.state.preset === 'GLORY' ? 'gm-btn-primary' : 'gm-btn-ghost'}" data-preset="GLORY">🏆 Glory (≥40%)</button>
          <button type="button" class="gm-btn gm-btn-sm ${this.state.preset === 'ELITE' ? 'gm-btn-primary' : 'gm-btn-ghost'}" data-preset="ELITE">👑 Elite (≥75%)</button>
        </div>
      </div>

      <div class="gm-card glass-card" style="padding:1rem 0.75rem;">
        <div class="gm-table-wrapper gm-table-scroll" style="overflow-x:auto; width:100%; -webkit-overflow-scrolling:touch; border-radius:var(--radius-md);">
          <table class="gm-table gm-draft-table" style="width:100%; border-collapse:collapse; min-width:820px;">
            <thead>
              <tr style="border-bottom: 2px solid var(--border-color); text-align:left; font-size:0.72rem; text-transform:uppercase; color:var(--text-muted);">
                <th style="padding:0.5rem 0.45rem; width:40px; text-align:center;">#</th>
                <th style="padding:0.5rem 0.45rem;">Player</th>
                <th style="padding:0.5rem 0.45rem; text-align:center;">Server</th>
                <th style="padding:0.5rem 0.45rem; text-align:center;">Guild</th>
                <th style="padding:0.5rem 0.45rem; text-align:right; cursor:pointer;" data-sort="power">Power</th>
                <th style="padding:0.5rem 0.45rem; text-align:center; cursor:pointer;" data-sort="draft_score">Draft Score</th>
                <th style="padding:0.5rem 0.45rem; text-align:center; cursor:pointer;" data-sort="day6_score" title="SvS & GvG Day 6 battle score with 2x doubled weight (0-100%)">⚔️ Day 6 (x2)</th>
                <th style="padding:0.5rem 0.45rem; text-align:center; cursor:pointer;" data-sort="shadow_rate" title="Priority 20v20 Shadowfront attendance (0-100%)">👻 Shadowfront</th>
                <th style="padding:0.5rem 0.45rem; text-align:center; cursor:pointer;" data-sort="glory_score" title="Glory score (0-100%)">🏆 Glory</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>`;

    this.wireControls();
  }

  private static wireControls(): void {
    const container = document.getElementById('cross-rank-container');
    if (!container) return;

    const searchInput = document.getElementById('cross-rank-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.state.query = searchInput.value;
        this.render();
        const nextInput = document.getElementById('cross-rank-search') as HTMLInputElement | null;
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
        }
      });
    }

    const serverSel = document.getElementById('cross-rank-server') as HTMLSelectElement | null;
    if (serverSel) {
      serverSel.addEventListener('change', () => {
        this.state.server = serverSel.value;
        this.render();
      });
    }

    const guildSel = document.getElementById('cross-rank-guild') as HTMLSelectElement | null;
    if (guildSel) {
      guildSel.addEventListener('change', () => {
        this.state.guild = guildSel.value;
        this.render();
      });
    }

    container.querySelectorAll('button[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-preset') as 'ALL' | 'DAY6' | 'SHADOW' | 'GLORY' | 'ELITE' | null;
        if (p) {
          this.state.preset = p;
          this.render();
        }
      });
    });

    container.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const sortKey = th.getAttribute('data-sort');
        if (!sortKey) return;
        if (this.state.sortKey === sortKey) {
          this.state.sortDesc = !this.state.sortDesc;
        } else {
          this.state.sortKey = sortKey;
          this.state.sortDesc = true;
        }
        this.render();
      });
    });
  }
}
