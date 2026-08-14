/**
 * src/modules/armsrace/armsrace-view.ts
 *
 * ES Module TypeScript implementation of Arms Race (Stage A & Stage B).
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export class ArmsRaceView {
  public static async load(): Promise<void> {
    if (typeof (window as any).loadArmsRace === 'function') {
      (window as any).loadArmsRace();
    }
  }

  public static async addMemberToActiveEvents(pseudo: string): Promise<void> {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    try {
      const currentG = (window as any).GM ? (window as any).GM.getActiveGuild() : 'ALPHA';
      await supabase.rpc('gm_add_member_to_active_events', {
        p_guild: currentG,
        p_pseudo: pseudo,
      });
    } catch (err) {
      logger.error('Failed to add member to active Arms Race events', err);
    }
  }
}
