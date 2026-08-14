/**
 * src/modules/glory/glory-view.ts
 *
 * ES Module TypeScript implementation of Glory View.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export class GloryView {
  public static async load(): Promise<void> {
    if (typeof (window as any).loadGlory === 'function') {
      (window as any).loadGlory();
    }
  }

  public static async savePlayerGlory(pseudo: string, weekStart: string, gloryScore: number): Promise<boolean> {
    const supabase = getSupabaseClient();
    if (!supabase) return false;
    try {
      const currentG = (window as any).GM ? (window as any).GM.getActiveGuild() : 'ALPHA';
      const { data, error } = await supabase.rpc('gm_upsert_player_glory', {
        p_guild: currentG,
        p_pseudo: pseudo,
        p_week_start: weekStart,
        p_glory: gloryScore,
      });

      if (error) {
        logger.error('Failed gm_upsert_player_glory', error);
        return false;
      }
      return true;
    } catch (err) {
      logger.error('Error saving player glory', err);
      return false;
    }
  }
}
