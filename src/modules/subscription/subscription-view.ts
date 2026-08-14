/**
 * src/modules/subscription/subscription-view.ts
 *
 * ES Module TypeScript implementation of Subscription & Self-Service Checkout.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export class SubscriptionView {
  public static async load(): Promise<void> {
    if (typeof (window as any).renderSubscriptionTab === 'function') {
      (window as any).renderSubscriptionTab();
    }
  }

  public static async getGuildSubscription(guild: string): Promise<any> {
    const supabase = getSupabaseClient();
    if (!supabase) return null;
    try {
      const { data, error } = await supabase
        .from('guilds')
        .select('id, name, subscription_type, subscription_end, server_number, payments_disabled')
        .eq('id', guild)
        .limit(1);

      if (error) {
        logger.error('Failed to fetch guild subscription', error);
        return null;
      }
      return data?.[0] ?? null;
    } catch (err) {
      logger.error('Error fetching subscription', err);
      return null;
    }
  }
}
