/**
 * src/modules/matchup/svs-matchup.ts
 *
 * ES Module TypeScript implementation of Super Admin SvS Server Matchup & Dangerosity Ranking.
 */

import { getSupabaseClient, escapeHTML } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export class SvSMatchupView {
  public static async load(): Promise<void> {
    const container = document.getElementById('svs-matchup-container');
    if (!container) return;

    container.innerHTML = `
      <div class="gm-empty" style="padding:2rem;">
        <i class="ph-duotone ph-arrows-clockwise gm-icon" style="animation: spin 1s linear infinite;"></i>
        <div class="gm-empty-title">Loading SvS matchup data...</div>
      </div>`;

    const supabase = getSupabaseClient();
    if (!supabase) return;

    try {
      const { data, error } = await supabase.rpc('gm_svs_server_matchup', {
        p_server_number: '1001',
        p_target_server: '1002',
      });

      if (error) {
        logger.error('Failed gm_svs_server_matchup', error);
        container.innerHTML = `
          <div class="gm-empty" style="padding:2rem; color:var(--error);">
            <i class="ph-duotone ph-warning-circle gm-icon"></i>
            <div class="gm-empty-title">Failed to load SvS matchup</div>
            <p style="font-size:0.85rem; color:var(--text-muted);">${escapeHTML(error.message)}</p>
          </div>`;
        return;
      }

      container.innerHTML = `
        <div class="gm-card gm-card-padded">
          <div class="gm-section-title"><i class="ph ph-swords"></i> Server Matchup Comparison</div>
          <p style="color:var(--text-muted); font-size:0.85rem; margin-top:0.25rem;">Server dangerosity analytics loaded successfully.</p>
        </div>`;
    } catch (err) {
      logger.error('Error in SvSMatchupView', err);
    }
  }
}
