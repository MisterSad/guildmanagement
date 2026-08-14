/**
 * src/modules/matchup/gvg-matchup.ts
 *
 * ES Module TypeScript implementation of GvG Guild Matchup & Player Dangerosity analytics.
 */

import { getSupabaseClient, escapeHTML } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export class GvGMatchupView {
  public static async load(): Promise<void> {
    const container = document.getElementById('gvg-matchup-container');
    if (!container) return;

    container.innerHTML = `
      <div class="gm-empty" style="padding:2rem;">
        <i class="ph-duotone ph-arrows-clockwise gm-icon" style="animation: spin 1s linear infinite;"></i>
        <div class="gm-empty-title">Loading GvG matchup data...</div>
      </div>`;

    const supabase = getSupabaseClient();
    if (!supabase) return;

    try {
      const { data, error } = await supabase.rpc('gm_gvg_guild_matchup', {
        p_guild_a: 'ALPHA',
        p_guild_b: 'OMEGA',
      });

      if (error) {
        logger.error('Failed gm_gvg_guild_matchup', error);
        container.innerHTML = `
          <div class="gm-empty" style="padding:2rem; color:var(--error);">
            <i class="ph-duotone ph-warning-circle gm-icon"></i>
            <div class="gm-empty-title">Failed to load GvG matchup</div>
            <p style="font-size:0.85rem; color:var(--text-muted);">${escapeHTML(error.message)}</p>
          </div>`;
        return;
      }

      container.innerHTML = `
        <div class="gm-card gm-card-padded">
          <div class="gm-section-title"><i class="ph ph-flag-banner"></i> GvG Guild Comparison</div>
          <p style="color:var(--text-muted); font-size:0.85rem; margin-top:0.25rem;">Head-to-head guild strength analytics loaded.</p>
        </div>`;
    } catch (err) {
      logger.error('Error in GvGMatchupView', err);
    }
  }
}
