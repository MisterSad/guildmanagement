// supabase/functions/_shared/rate-limit.ts
// Pure decision logic and database-backed sliding window rate limiter

export interface ThrottleRecord {
  window_start: string | Date | number;
  attempts: number;
}

export function isWindowExpired(windowStart: number, now: number, windowMs: number): boolean {
  return now - windowStart > windowMs;
}

export function extractClientIp(headers: Headers | Record<string, string | null | undefined>): string {
  let cfIp: string | null = null;
  let xRealIp: string | null = null;
  let xff: string | null = null;

  if (headers instanceof Headers) {
    cfIp = headers.get("cf-connecting-ip");
    xRealIp = headers.get("x-real-ip");
    xff = headers.get("x-forwarded-for");
  } else {
    cfIp = headers["cf-connecting-ip"] || null;
    xRealIp = headers["x-real-ip"] || null;
    xff = headers["x-forwarded-for"] || null;
  }

  // 1. Cloudflare authoritative connecting IP (cannot be forged through Cloudflare proxy)
  if (cfIp && typeof cfIp === "string" && cfIp.trim()) {
    return cfIp.trim();
  }

  // 2. Nearest proxy hop from X-Forwarded-For
  if (xff && typeof xff === "string") {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  // 3. Fallback to X-Real-IP
  if (xRealIp && typeof xRealIp === "string" && xRealIp.trim()) {
    return xRealIp.trim();
  }

  return "127.0.0.1";
}

export function shouldThrottle(options: {
  recentWindows: ThrottleRecord[];
  limit: number;
  windowMs: number;
  now: number;
}): boolean {
  const { recentWindows, limit, windowMs, now } = options;
  let totalAttempts = 0;
  const threshold = now - windowMs;

  for (const win of recentWindows) {
    const startTime = typeof win.window_start === "number"
      ? win.window_start
      : new Date(win.window_start).getTime();
    if (startTime >= threshold) {
      totalAttempts += Number(win.attempts) || 0;
    }
  }

  return totalAttempts >= limit;
}

// Per-Discord-user budget for discord-profile-verification, which is
// reachable by any Discord user posting in a monitored channel and calls a
// metered vision API on every attempt.
//
// Delegated to the atomic public.gm_check_verification_throttle RPC, exactly
// like checkAndRecordIpAttempt below. It used to read the window and write the
// bucket in two round trips (concurrent posts both passed) and returned
// `allowed: true` on any error, against AGENTS.md rule 7 (audit SEC-12).
// Retention: gm_purge_discord_ephemera drops windows older than a day.
export async function checkAndRecordDiscordAttempt(
  admin: any,
  discordUserId: string,
  options: { limit: number; windowMs: number }
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const { limit, windowMs } = options;
  const windowStartIso = new Date(Math.floor(now / 60000) * 60000).toISOString(); // 1-minute bucket

  try {
    const { data, error } = await admin.rpc("gm_check_verification_throttle", {
      p_discord_user_id: discordUserId,
      p_limit: limit,
      p_window_ms: windowMs,
      p_bucket: windowStartIso,
    });
    // FAIL CLOSED: a database that cannot count attempts cannot vouch for them.
    if (error) return { allowed: false, remaining: 0 };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { allowed: false, remaining: 0 };
    return {
      allowed: row.allowed !== false,
      remaining: Math.max(0, Number(row.remaining) || 0),
    };
  } catch {
    return { allowed: false, remaining: 0 };
  }
}

// Sliding-window IP throttle, delegated to the atomic public.gm_check_ip_throttle
// RPC: the database does the SUM and the bucket increment (INSERT ... ON CONFLICT
// DO UPDATE) in one transaction, so concurrent calls on the same (ip, bucket)
// can no longer raise login_throttle_pkey violations or lose increments the way
// the previous SELECT-then-INSERT/UPDATE did. Retention is handled by the
// scheduled `login-throttle-retention` pg_cron job, not per request.
export async function checkAndRecordIpAttempt(
  admin: any,
  ip: string,
  options: { limit: number; windowMs: number }
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const { limit, windowMs } = options;
  const windowStartIso = new Date(Math.floor(now / 60000) * 60000).toISOString(); // 1-minute bucket

  try {
    const { data, error } = await admin.rpc("gm_check_ip_throttle", {
      p_ip: ip,
      p_limit: limit,
      p_window_ms: windowMs,
      p_bucket: windowStartIso,
    });

    if (error) {
      // FAIL CLOSED (finding B3). This used to return `allowed: true` on any
      // database error, so pressure on the database silently disabled login,
      // sign-up and OCR throttling at exactly the moment an attacker would be
      // causing it. Failing closed costs nothing real: every caller of this
      // helper goes on to read `accounts` anyway, so if the database cannot
      // answer here it cannot serve the request either.
      return { allowed: false, remaining: 0 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { allowed: false, remaining: 0 };

    return {
      allowed: row.allowed !== false,
      remaining: Math.max(0, Number(row.remaining) || 0),
    };
  } catch {
    return { allowed: false, remaining: 0 };
  }
}
