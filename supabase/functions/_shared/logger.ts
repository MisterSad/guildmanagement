/**
 * supabase/functions/_shared/logger.ts
 *
 * Unified structured JSON logging module for Deno Edge Functions.
 * Provides log levels, automatic PII / credentials sanitization, correlation IDs,
 * duration tracking, and structured output.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

const LOG_LEVEL_WEIGHTS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

const CURRENT_LOG_LEVEL: LogLevel = (Deno.env.get("LOG_LEVEL") as LogLevel) || "INFO";

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "gotrue_secret",
  "p_secret",
  "p_password",
  "token",
  "authorization",
  "apikey",
  "api_key",
  "service_role",
  "service_role_key",
  "gemini_api_key",
  "stripe_secret_key",
  "stripe_webhook_signing_secret",
  "private_key",
  "vapid_private_key",
]);

// Key-based redaction (sanitizeData) only catches values under a sensitive
// *key name*. A value interpolated straight into a message string
// (`throw new Error('bad key: ' + key)`) or an error's stack trace bypasses
// that entirely, so free-text messages/stacks are also scanned for
// known-shaped secrets before logging.
const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT (Supabase access/service tokens)
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}\b/gi, // Stripe secret/publishable/webhook keys
  // Supabase's current key formats. The scrubbers only knew the legacy `eyJ…`
  // JWT shape, so a modern secret key pasted into an error message went
  // straight through (finding B3).
  /\bsb_secret_[A-Za-z0-9_-]{10,}\b/gi,
  /\bsb_publishable_[A-Za-z0-9_-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
  /\b(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
];

export function redactSensitiveText(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Deeply sanitizes objects by masking sensitive credentials.
 */
export function sanitizeData(data: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeData(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes("password") || lowerKey.includes("secret") || lowerKey.includes("token")) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeData(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  correlationId?: string;
  tenantId?: string | null;
  userId?: string | null;
  action?: string;
  durationMs?: number;
  message: string;
  metadata?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

export class EdgeLogger {
  private service: string;
  private correlationId: string;
  private tenantId: string | null = null;
  private userId: string | null = null;
  private startTime: number;

  constructor(service: string, req?: Request) {
    this.service = service;
    this.correlationId = req?.headers.get("x-correlation-id") || req?.headers.get("x-request-id") || `req_${crypto.randomUUID()}`;
    this.startTime = performance.now();
  }

  public setContext(context: { tenantId?: string | null; userId?: string | null }): void {
    if (context.tenantId !== undefined) this.tenantId = context.tenantId;
    if (context.userId !== undefined) this.userId = context.userId;
  }

  public getCorrelationId(): string {
    return this.correlationId;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHTS[level] >= LOG_LEVEL_WEIGHTS[CURRENT_LOG_LEVEL];
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>, err?: Error | unknown): void {
    if (!this.shouldLog(level)) return;

    const durationMs = Math.round((performance.now() - this.startTime) * 100) / 100;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      correlationId: this.correlationId,
      tenantId: this.tenantId,
      userId: this.userId,
      durationMs,
      message: redactSensitiveText(message),
      metadata: meta ? (sanitizeData(meta) as Record<string, unknown>) : undefined,
    };

    if (err) {
      if (err instanceof Error) {
        entry.error = {
          name: err.name,
          message: redactSensitiveText(err.message),
          stack: err.stack ? redactSensitiveText(err.stack) : undefined,
        };
      } else {
        entry.error = {
          message: redactSensitiveText(String(err)),
        };
      }
    }

    const jsonString = JSON.stringify(entry);

    if (level === "ERROR" || level === "FATAL") {
      console.error(jsonString);
      // Asynchronously record critical errors in Postgres system_audit_logs if DB credentials exist
      this.persistToAuditLogs(entry).catch((e) => console.warn("Failed to persist audit log:", e.message));
    } else if (level === "WARN") {
      console.warn(jsonString);
    } else {
      console.log(jsonString);
    }
  }

  private async persistToAuditLogs(entry: LogEntry): Promise<void> {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return;

    try {
      const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
      await client.from("system_audit_logs").insert({
        level: entry.level,
        service: entry.service,
        correlation_id: entry.correlationId,
        guild: entry.tenantId,
        user_identifier: entry.userId,
        message: entry.message,
        metadata: entry.metadata ?? {},
        error_details: entry.error ?? null,
        duration_ms: entry.durationMs,
      });
    } catch (_) {
      // Best-effort database log insertion without failing request
    }
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    this.write("DEBUG", message, meta);
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.write("INFO", message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.write("WARN", message, meta);
  }

  public error(message: string, err?: Error | unknown, meta?: Record<string, unknown>): void {
    this.write("ERROR", message, meta, err);
  }

  public fatal(message: string, err?: Error | unknown, meta?: Record<string, unknown>): void {
    this.write("FATAL", message, meta, err);
  }
}
