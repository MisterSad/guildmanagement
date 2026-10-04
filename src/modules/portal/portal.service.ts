/**
 * src/modules/portal/portal.service.ts
 *
 * ES Module TypeScript service managing Player Portal requests
 * via the service_role authenticated member-portal Edge Function.
 */

import { getSupabaseClient, parseFunctionsInvokeResult } from '../../core/api/supabase';
import { logger } from '../../core/logger/logger';

export interface PortalResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
  [key: string]: any;
}

export class PortalService {
  public static async invokeAction<T = any>(
    action: string,
    payload: Record<string, any> = {}
  ): Promise<PortalResponse<T>> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    try {
      const res = await supabase.functions.invoke('member-portal', {
        body: { action, payload },
      });

      // Recover the real {ok, error} body even when the platform gateway
      // rejected the request with a non-2xx status (rate limit, ...). Without
      // this, supabase-js discards that body and every failure collapses into a
      // generic "request_failed".
      const parsed = await this.parseInvokeResult(res);
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'request_failed' };
      }
      return parsed as PortalResponse<T>;
    } catch (e: any) {
      logger.error(`PortalService action [${action}] threw exception`, e);
      return { ok: false, error: 'request_failed' };
    }
  }

  /** Recovers the real {ok, error} body through the shared Functions helper. */
  private static async parseInvokeResult(result: any): Promise<any> {
    return parseFunctionsInvokeResult(result);
  }

  public static async getActiveSessions(): Promise<PortalResponse> {
    return this.invokeAction('get-active-sessions');
  }

  public static async getHistory(): Promise<PortalResponse> {
    return this.invokeAction('get-history');
  }

  public static async getPersonalKPIs(): Promise<PortalResponse> {
    return this.invokeAction('get-personal-kpis');
  }

  public static async getWeeklyChallenges(): Promise<PortalResponse> {
    return this.invokeAction('get-weekly-challenges');
  }

  public static async getBadges(): Promise<PortalResponse> {
    return this.invokeAction('get-badges');
  }

  public static async getTransferGuilds(): Promise<PortalResponse> {
    return this.invokeAction('get-transfer-guilds');
  }

  public static async updateTimezone(offset: number): Promise<PortalResponse> {
    return this.invokeAction('update-timezone', { offset });
  }

  public static async getAbsences(): Promise<PortalResponse> {
    return this.invokeAction('get-absences');
  }

  public static async setAbsence(payload: {
    start_date: string;
    end_date: string;
    kind?: string;
    note?: string;
  }): Promise<PortalResponse> {
    return this.invokeAction('set-absence', payload);
  }

  public static async deleteAbsence(id: string): Promise<PortalResponse> {
    return this.invokeAction('delete-absence', { id });
  }

  public static async submitScorePayload(payload: Record<string, any>): Promise<PortalResponse> {
    return this.invokeAction('submit-scores', payload);
  }

  public static async submitEventScore(eventName: string, sessionId: string, score: number): Promise<PortalResponse> {
    return this.invokeAction('submit-scores', {
      event_name: eventName,
      session_id: sessionId,
      score,
      participated: true,
    });
  }

  public static async updatePower(overallPower: number): Promise<PortalResponse> {
    return this.invokeAction('update-power', { power: overallPower });
  }

  public static async updateMetrics(metrics: {
    total_power?: number;
    tech_power?: number;
    champion_power?: number;
    crew_power?: number;
    flagship_power?: number;
    fleet_rating?: number;
    glory_score?: number;
  }): Promise<PortalResponse> {
    return this.invokeAction('update-metrics', metrics);
  }

  public static async getMetricsHistory(limit: number = 12): Promise<PortalResponse> {
    return this.invokeAction('get-metrics-history', { limit });
  }

  public static async declareAbsence(startDate: string, endDate: string, reason: string): Promise<PortalResponse> {
    return this.invokeAction('set-absence', {
      start_date: startDate,
      end_date: endDate,
      kind: 'full',
      note: reason,
    });
  }
}
