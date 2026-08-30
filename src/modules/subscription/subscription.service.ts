/**
 * src/modules/subscription/subscription.service.ts
 *
 * API layer for the donation/subscription module. Talks to the same
 * Supabase Edge Functions the legacy subscription.js used
 * (gm-create-order for config, member-portal for donation checkout).
 */

import { logger } from '../../core/logger/logger';

// Deliberately NOT core/api/supabase's getSupabaseClient(): that helper
// caches the client in a module-level variable on first call, so once
// anything captures it, later reassignments of window.GM.db (e.g. a
// re-login, or a test swapping in a mock) are silently ignored. Legacy
// subscription.js always read window.GM.db fresh on every call — this
// matches that.
function getDb(): any {
  return (typeof window !== 'undefined' && (window as any).GM && (window as any).GM.db) || null;
}

export interface SubscriptionConfig {
  ok: boolean;
  mode?: string;
  configured?: boolean;
  error?: string;
}

export interface CreateDonationResult {
  ok: boolean;
  url?: string;
  sessionId?: string;
  error?: string;
}

export interface GuildSummary {
  type: string;
  end: string | null;
  server_number: string;
  paymentsDisabled: boolean;
}

export class SubscriptionService {
  public static async getConfig(): Promise<SubscriptionConfig> {
    const db = getDb();
    if (!db) return { ok: false, error: 'no_db' };
    try {
      const res: any = await (db as any).functions.invoke('gm-create-order', { body: { action: 'config' } });
      const data = res?.data || {};
      if (!data.ok) return { ok: false, error: data.error || 'config_failed' };
      return data;
    } catch (err) {
      logger.error('Failed to load subscription config', err);
      return { ok: false, error: 'load_failed' };
    }
  }

  public static async createDonationCheckout(params: {
    plan: string;
    guildId: string;
    returnUrl: string;
    amountCents?: number;
  }): Promise<CreateDonationResult> {
    const db = getDb();
    if (!db) return { ok: false, error: 'no_db' };

    const payload: Record<string, unknown> = {
      plan: params.plan,
      guildId: params.guildId,
      returnUrl: params.returnUrl,
    };
    if (params.plan === 'donation_custom') {
      payload.amountCents = params.amountCents;
    }

    try {
      const res: any = await (db as any).functions.invoke('member-portal', {
        body: { action: 'create-donation', payload },
      });
      const data = res?.data || {};
      if (!data.ok || !data.url) return { ok: false, error: data.error || 'order_failed' };
      return data;
    } catch (err) {
      logger.error('Failed to create donation checkout', err);
      return { ok: false, error: 'order_failed' };
    }
  }

  // Refreshes window.guildsData / window.guildsList (read by the legacy
  // shell/sidebar) and re-renders the shell if it's already mounted. Same
  // shared cache the rest of the app reads — not a service-local cache.
  public static async refreshGuildsData(): Promise<void> {
    const db = getDb();
    if (!db) return;
    try {
      const res: any = await (db as any)
        .from('guilds')
        .select('id, subscription_type, subscription_end, server_number, payments_disabled')
        .order('id');
      if (res.error || !res.data || res.data.length === 0) return;

      const w = window as any;
      w.guildsList = res.data.map((g: any) => g.id);
      w.guildsData = {};
      res.data.forEach((g: any) => {
        const sNum = g.server_number || localStorage.getItem('gm_server_number_' + g.id) || '';
        w.guildsData[g.id] = {
          type: g.subscription_type || 'Unlimited',
          end: g.subscription_end || null,
          server_number: sNum,
          paymentsDisabled: !!g.payments_disabled,
        } as GuildSummary;
      });
      if (w.GM_SHELL) {
        if (w.GM_SHELL.renderSidebar) w.GM_SHELL.renderSidebar();
        if (w.GM_SHELL.renderTopbar) w.GM_SHELL.renderTopbar();
      }
    } catch {
      // non-fatal, matches legacy behavior
    }
  }
}
