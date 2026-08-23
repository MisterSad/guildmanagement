import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  isWindowExpired,
  shouldThrottle,
  extractClientIp
} from '../supabase/functions/_shared/rate-limit.ts';

describe('Sliding Window IP Rate Limiter (GAP 3)', () => {
  it('isWindowExpired correctly evaluates window duration', () => {
    const now = 1000000;
    const windowMs = 60000;

    expect(isWindowExpired(now - 70000, now, windowMs)).toBe(true);
    expect(isWindowExpired(now - 60000, now, windowMs)).toBe(false);
    expect(isWindowExpired(now - 30000, now, windowMs)).toBe(false);
    expect(isWindowExpired(now, now, windowMs)).toBe(false);
  });

  it('extractClientIp selects the rightmost trusted proxy IP from X-Forwarded-For', () => {
    // 1. Multiple hops - rightmost is the true peer connecting to the edge
    const headers1 = new Headers({
      'x-forwarded-for': '203.0.113.195, 198.51.100.10, 192.0.2.1'
    });
    expect(extractClientIp(headers1)).toBe('192.0.2.1');

    // 2. Single IP in XFF
    const headers2 = new Headers({
      'x-forwarded-for': '198.51.100.42'
    });
    expect(extractClientIp(headers2)).toBe('198.51.100.42');

    // 3. Fallback to cf-connecting-ip
    const headers3 = new Headers({
      'cf-connecting-ip': '203.0.113.88'
    });
    expect(extractClientIp(headers3)).toBe('203.0.113.88');

    // 4. Fallback to x-real-ip
    const headers4 = new Headers({
      'x-real-ip': '198.51.100.99'
    });
    expect(extractClientIp(headers4)).toBe('198.51.100.99');

    // 5. Plain object headers input
    const plainHeaders = {
      'x-forwarded-for': 'spoofed.attacker.ip, 192.0.2.55'
    };
    expect(extractClientIp(plainHeaders)).toBe('192.0.2.55');

    // 6. Missing headers fallback
    expect(extractClientIp(new Headers())).toBe('127.0.0.1');
    expect(extractClientIp({})).toBe('127.0.0.1');
  });

  it('shouldThrottle correctly enforces limit at the boundary and ignores expired windows', () => {
    const now = 1000000;
    const windowMs = 300000; // 5 minutes
    const limit = 5;

    // Under limit (4 attempts)
    const recordsUnder = [
      { window_start: now - 60000, attempts: 2 },
      { window_start: now - 120000, attempts: 2 }
    ];
    expect(shouldThrottle({ recentWindows: recordsUnder, limit, windowMs, now })).toBe(false);

    // Exactly at limit (5 attempts) -> throttled
    const recordsAtLimit = [
      { window_start: now - 60000, attempts: 3 },
      { window_start: now - 120000, attempts: 2 }
    ];
    expect(shouldThrottle({ recentWindows: recordsAtLimit, limit, windowMs, now })).toBe(true);

    // Over limit (6 attempts) -> throttled
    const recordsOver = [
      { window_start: now - 60000, attempts: 4 },
      { window_start: now - 120000, attempts: 2 }
    ];
    expect(shouldThrottle({ recentWindows: recordsOver, limit, windowMs, now })).toBe(true);

    // Expired attempts excluded (4 old + 2 recent = 2 valid < 5 limit)
    const recordsWithExpired = [
      { window_start: now - 400000, attempts: 4 }, // expired (> 300s ago)
      { window_start: now - 50000, attempts: 2 }
    ];
    expect(shouldThrottle({ recentWindows: recordsWithExpired, limit, windowMs, now })).toBe(false);
  });

  it('containment: verifies login_throttle migration and auth-login rate limiting wiring', () => {
    const migPath = path.resolve(__dirname, '../supabase/migrations/20260823110000_login_throttle_ip.sql');
    expect(fs.existsSync(migPath)).toBe(true);
    const migContent = fs.readFileSync(migPath, 'utf-8');
    expect(migContent).toContain('CREATE TABLE IF NOT EXISTS public.login_throttle');
    expect(migContent).toContain('idx_login_throttle_ip_time');
    expect(migContent).toContain('interval \'15 minutes\'');

    const authLoginContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/auth-login/index.ts'), 'utf-8');
    expect(authLoginContent).toContain('too_many_attempts');
    expect(authLoginContent).toContain('checkAndRecordIpAttempt');
    expect(authLoginContent).toContain('extractClientIp');

    const adminAccountsContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/admin-accounts/index.ts'), 'utf-8');
    expect(adminAccountsContent).toContain('checkAndRecordIpAttempt');

    const memberPortalContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/member-portal/index.ts'), 'utf-8');
    expect(memberPortalContent).toContain('checkAndRecordIpAttempt');
  });
});
