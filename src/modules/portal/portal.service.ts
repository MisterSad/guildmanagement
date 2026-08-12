/**
 * src/modules/portal/portal.service.ts
 *
 * ES Module TypeScript service managing Player Portal requests
 * via the service_role authenticated member-portal Edge Function.
 */

import { getSupabaseClient } from '../../core/api/supabase';

export interface PortalResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
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
        body: { action, payload }
      });

      if (!res || !res.data) {
        return {
          ok: false,
          error: (res && res.error && res.error.message) || 'request_failed'
        };
      }

      return res.data as PortalResponse<T>;
    } catch (e: any) {
      console.error(`PortalService action [${action}] failed:`, e);
      return { ok: false, error: 'request_failed' };
    }
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

  public static async submitEventScore(
    eventName: string,
    sessionId: string,
    score: number
  ): Promise<PortalResponse> {
    return this.invokeAction('submit-score', { event_name: eventName, session_id: sessionId, score });
  }

  public static async updatePower(overallPower: number): Promise<PortalResponse> {
    return this.invokeAction('update-power', { overall_power: overallPower });
  }

  public static async declareAbsence(
    startDate: string,
    endDate: string,
    reason: string
  ): Promise<PortalResponse> {
    return this.invokeAction('declare-absence', { start_date: startDate, end_date: endDate, reason });
  }
}
