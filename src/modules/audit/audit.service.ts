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
  guild?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogStats {
  total24h: number;
  errors24h: number;
  fatal24h: number;
  warn24h: number;
  avgDurationMs: number;
}

export class AuditService {
  public static async getLogs(filters: AuditLogFilter = {}): Promise<{ logs: SystemAuditLog[]; count: number }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { logs: [], count: 0 };

    const limit = Math.min(filters.limit || 50, 200);
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
    if (filters.guild && filters.guild !== 'ALL') {
      query = query.eq('guild', filters.guild);
    }
    if (filters.search && filters.search.trim()) {
      const s = filters.search.trim();
      query = query.or(`message.ilike.%${s}%,correlation_id.ilike.%${s}%,user_identifier.ilike.%${s}%`);
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
      return { total24h: 0, errors24h: 0, fatal24h: 0, warn24h: 0, avgDurationMs: 0 };
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('system_audit_logs')
      .select('level, duration_ms')
      .gte('created_at', since);

    if (error || !data) {
      return { total24h: 0, errors24h: 0, fatal24h: 0, warn24h: 0, avgDurationMs: 0 };
    }

    let errors24h = 0;
    let fatal24h = 0;
    let warn24h = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const row of data) {
      if (row.level === 'ERROR') errors24h++;
      if (row.level === 'FATAL') fatal24h++;
      if (row.level === 'WARN') warn24h++;
      if (typeof row.duration_ms === 'number') {
        durationSum += row.duration_ms;
        durationCount++;
      }
    }

    const avgDurationMs = durationCount > 0 ? Math.round((durationSum / durationCount) * 10) / 10 : 0;

    return {
      total24h: data.length,
      errors24h,
      fatal24h,
      warn24h,
      avgDurationMs,
    };
  }
}
