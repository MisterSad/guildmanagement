/**
 * src/core/logger/logger.ts
 *
 * Structured client-side logger for FGF Guild Management Tool.
 * Formats console logs as structured JSON, masks credentials/PII,
 * tracks correlation IDs and execution durations.
 */

import { getSupabaseClient } from '../api/supabase';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

const LOG_LEVEL_WEIGHTS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'gotrue_secret',
  'token',
  'authorization',
  'apikey',
  'key',
  'p_secret',
  'p_password'
]);

function sanitizeClientData(data: unknown, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeClientData(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || lower.includes('password') || lower.includes('secret') || lower.includes('token')) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeClientData(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export interface ClientLogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  correlationId: string;
  tenantId?: string | null;
  userId?: string | null;
  durationMs?: number;
  message: string;
  metadata?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

class ClientLogger {
  private service = 'fgf-client';
  private correlationId = `session_${Math.random().toString(36).substring(2, 10)}`;
  private tenantId: string | null = null;
  private userId: string | null = null;
  private currentLevel: LogLevel = 'INFO';

  public setContext(context: { tenantId?: string | null; userId?: string | null }): void {
    if (context.tenantId !== undefined) this.tenantId = context.tenantId;
    if (context.userId !== undefined) this.userId = context.userId;
  }

  public setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  public getCorrelationId(): string {
    return this.correlationId;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHTS[level] >= LOG_LEVEL_WEIGHTS[this.currentLevel];
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>, err?: Error | unknown): void {
    if (!this.shouldLog(level)) return;

    const entry: ClientLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      correlationId: this.correlationId,
      tenantId: this.tenantId || (typeof localStorage !== 'undefined' ? localStorage.getItem('gm_current_guild') : null),
      userId: this.userId || (typeof localStorage !== 'undefined' ? localStorage.getItem('gm_user') : null),
      message,
      metadata: meta ? (sanitizeClientData(meta) as Record<string, unknown>) : undefined,
    };

    if (err) {
      if (err instanceof Error) {
        entry.error = {
          name: err.name,
          message: err.message,
          stack: err.stack,
        };
      } else {
        entry.error = {
          message: String(err),
        };
      }
    }

    const prefix = `[${entry.timestamp}] [${entry.level}] [${entry.service}] [${entry.correlationId}]`;

    if (level === 'ERROR' || level === 'FATAL') {
      console.error(prefix, message, entry.metadata || '', entry.error || '');
      this.reportCriticalError(entry).catch(() => {});
    } else if (level === 'WARN') {
      console.warn(prefix, message, entry.metadata || '');
    } else {
      console.log(prefix, message, entry.metadata || '');
    }
  }

  private async reportCriticalError(entry: ClientLogEntry): Promise<void> {
    try {
      const supabase = getSupabaseClient();
      if (!supabase) return;
      await supabase.from('system_audit_logs').insert({
        level: entry.level,
        service: entry.service,
        correlation_id: entry.correlationId,
        guild: entry.tenantId,
        user_identifier: entry.userId,
        message: entry.message,
        metadata: entry.metadata ?? {},
        error_details: entry.error ?? null,
      });
    } catch (_) {
      // Best-effort remote logging
    }
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    this.write('DEBUG', message, meta);
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.write('INFO', message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.write('WARN', message, meta);
  }

  public error(message: string, err?: Error | unknown, meta?: Record<string, unknown>): void {
    this.write('ERROR', message, meta, err);
  }

  public fatal(message: string, err?: Error | unknown, meta?: Record<string, unknown>): void {
    this.write('FATAL', message, meta, err);
  }
}

export const logger = new ClientLogger();
