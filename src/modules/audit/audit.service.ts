/**
 * src/modules/audit/audit.service.ts
 *
 * ES Module TypeScript service managing System Audit Logs and real-time
 * observability for Super Admins.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { SystemAuditLog } from '../../types/database';
import { logger } from '../../core/logger/logger';

export interface AuditLogFilter {
  level?: string;
  service?: string;
  action_type?: string;
  guild?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogStats {
  total24h: number;
  scores24h: number;
  metrics24h: number;
  uniquePlayers24h: number;
  errors24h: number;
  avgDurationMs: number;
}

export class AuditService {
  public static async getLogs(filters: AuditLogFilter = {}): Promise<{ logs: SystemAuditLog[]; count: number }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { logs: [], count: 0 };

    const limit = Math.min(filters.limit || 100, 300);
    const offset = filters.offset || 0;

    let query = supabase
      .from('system_audit_logs')
      .select('*', { count: 'exact' });

    if (filters.level && filters.level !== 'ALL') {
      query = query.eq('level', filters.level);
    }
    if (filters.service && filters.service !== 'ALL') {
      query = query.eq('service', filters.service);
    }
    if (filters.action_type && filters.action_type !== 'ALL') {
      query = query.eq('action_type', filters.action_type);
    }
    if (filters.guild && filters.guild !== 'ALL') {
      query = query.eq('guild', filters.guild);
    }
    if (filters.search && filters.search.trim()) {
      const s = filters.search.trim();
      query = query.or(`pseudo.ilike.%${s}%,uid.ilike.%${s}%,message.ilike.%${s}%,server_number.ilike.%${s}%,guild.ilike.%${s}%,user_identifier.ilike.%${s}%`);
    }

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;

    if (error) {
      logger.error('Failed to fetch system audit logs', error, { filters });
      return { logs: [], count: 0 };
    }

    return { logs: (data || []) as SystemAuditLog[], count: count || 0 };
  }

  public static async getStats(): Promise<AuditLogStats> {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return { total24h: 0, scores24h: 0, metrics24h: 0, uniquePlayers24h: 0, errors24h: 0, avgDurationMs: 0 };
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('system_audit_logs')
      .select('action_type, pseudo, uid, level, duration_ms')
      .gte('created_at', since);

    if (error || !data) {
      return { total24h: 0, scores24h: 0, metrics24h: 0, uniquePlayers24h: 0, errors24h: 0, avgDurationMs: 0 };
    }

    let scores24h = 0;
    let metrics24h = 0;
    let errors24h = 0;
    let durationSum = 0;
    let durationCount = 0;
    const uniquePlayers = new Set<string>();

    for (const row of data) {
      if (row.action_type === 'score_submission') scores24h++;
      if (row.action_type === 'metrics_update' || row.action_type === 'power_update' || row.action_type === 'glory_update') metrics24h++;
      if (row.level === 'ERROR' || row.level === 'FATAL') errors24h++;
      if (row.uid) {
        uniquePlayers.add(row.uid);
      } else if (row.pseudo && row.pseudo !== 'System' && row.action_type) {
        uniquePlayers.add(row.pseudo);
      }

      if (typeof row.duration_ms === 'number') {
        durationSum += row.duration_ms;
        durationCount++;
      }
    }

    const avgDurationMs = durationCount > 0 ? Math.round((durationSum / durationCount) * 10) / 10 : 0;

    return {
      total24h: data.length,
      scores24h,
      metrics24h,
      uniquePlayers24h: uniquePlayers.size,
      errors24h,
      avgDurationMs,
    };
  }
}
