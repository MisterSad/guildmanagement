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

// In-isolate throttling cache & DB sync helper
let lastDiscordPurgeTime = 0;

// Same sliding-window logic as checkAndRecordIpAttempt, but keyed by a
// Discord user id against discord_verification_throttle instead of an IP
// against login_throttle -- needed because the profile-verification
// endpoint is reachable by any Discord user posting in a monitored channel,
// not gated behind a login, and each attempt calls a metered AI vision API.
export async function checkAndRecordDiscordAttempt(
  admin: any,
  discordUserId: string,
  options: { limit: number; windowMs: number }
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const { limit, windowMs } = options;
  const windowStartIso = new Date(Math.floor(now / 60000) * 60000).toISOString();
  const cutoffIso = new Date(now - windowMs).toISOString();

  try {
    const { data: rows, error: fetchErr } = await admin
      .from("discord_verification_throttle")
      .select("window_start, attempts")
      .eq("discord_user_id", discordUserId)
      .gte("window_start", cutoffIso);

    if (fetchErr) {
      return { allowed: true, remaining: 1 };
    }

    const records: ThrottleRecord[] = rows || [];
    const isThrottled = shouldThrottle({ recentWindows: records, limit, windowMs, now });
    let currentTotal = records.reduce((sum, r) => sum + (Number(r.attempts) || 0), 0);

    if (isThrottled) {
      return { allowed: false, remaining: 0 };
    }

    const { data: existingBucket } = await admin
      .from("discord_verification_throttle")
      .select("attempts")
      .eq("discord_user_id", discordUserId)
      .eq("window_start", windowStartIso)
      .maybeSingle();

    if (existingBucket) {
      await admin
        .from("discord_verification_throttle")
        .update({ attempts: (existingBucket.attempts || 0) + 1 })
        .eq("discord_user_id", discordUserId)
        .eq("window_start", windowStartIso);
    } else {
      await admin
        .from("discord_verification_throttle")
        .insert({ discord_user_id: discordUserId, window_start: windowStartIso, attempts: 1 });
    }

    if (now - lastDiscordPurgeTime > 600000) {
      lastDiscordPurgeTime = now;
      const purgeCutoff = new Date(now - 86400000).toISOString();
      admin
        .from("discord_verification_throttle")
        .delete()
        .lt("window_start", purgeCutoff)
        .then(() => {})
        .catch(() => {});
    }

    return { allowed: true, remaining: Math.max(0, limit - (currentTotal + 1)) };
  } catch {
    return { allowed: true, remaining: 1 };
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
      // Fail open on database error to avoid locking legitimate users
      return { allowed: true, remaining: 1 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { allowed: true, remaining: 1 };

    return {
      allowed: row.allowed !== false,
      remaining: Math.max(0, Number(row.remaining) || 0),
    };
  } catch {
    return { allowed: true, remaining: 1 };
  }
}
