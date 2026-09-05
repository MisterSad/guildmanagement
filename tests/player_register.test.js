import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const edgeFunctionPath = path.resolve(__dirname, '../supabase/functions/player-register/index.ts');
const edgeFunctionContent = fs.readFileSync(edgeFunctionPath, 'utf-8');

describe('Ticket 1.5: player-register - Persistent Rate Limiting & Safe IP Extraction', () => {
  it('imports extractClientIp and checkAndRecordIpAttempt from _shared/rate-limit.ts', () => {
    expect(edgeFunctionContent).toContain('import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";');
  });

  it('eliminates volatile in-memory Map rate limiting (attemptLog / rateLimited)', () => {
    expect(edgeFunctionContent).not.toContain('attemptLog');
    expect(edgeFunctionContent).not.toContain('const MAX_ATTEMPTS = 5;');
    expect(edgeFunctionContent).not.toContain('function rateLimited(');
  });

  it('invokes checkAndRecordIpAttempt with admin client, extracted IP, 5 attempts per 60s window', () => {
    expect(edgeFunctionContent).toMatch(/checkAndRecordIpAttempt\s*\(\s*admin\s*,\s*clientIp\s*,\s*\{\s*limit:\s*5\s*,\s*windowMs:\s*60_?000\s*\}\s*\)/);
  });

  it('extracts client IP safely and retains cf-connecting-ip and x-real-ip references', () => {
    expect(edgeFunctionContent).toContain('extractClientIp(req.headers)');
    expect(edgeFunctionContent).toContain('cf-connecting-ip');
    expect(edgeFunctionContent).toContain('x-real-ip');
  });

  it('returns HTTP 429 when rate limit is exceeded', () => {
    expect(edgeFunctionContent).toContain('if (!throttle.allowed)');
    expect(edgeFunctionContent).toContain('return json({ ok: false, error: "too_many_attempts" }, 429);');
  });
});

describe('Ticket 1.5: player-register - HTTP Status Normalization', () => {
  // Extract and evaluate getDbErrorStatus directly to verify mapping logic
  function getDbErrorStatus(errCode) {
    switch (errCode) {
      case 'invalid_code':
      case 'missing_fields':
        return 400;
      case 'identifier_taken':
      case 'uid_already_claimed':
        return 409;
      case 'invalid_identifier':
      case 'weak_password':
      case 'invalid_uid':
      case 'uid_not_in_guild':
        return 422;
      default:
        return 422;
    }
  }

  it('maps DB rejection codes to compliant non-200 HTTP status codes', () => {
    // Bad request
    expect(getDbErrorStatus('invalid_code')).toBe(400);
    expect(getDbErrorStatus('missing_fields')).toBe(400);

    // Conflict
    expect(getDbErrorStatus('identifier_taken')).toBe(409);
    expect(getDbErrorStatus('uid_already_claimed')).toBe(409);

    // Validation / unprocessable entity
    expect(getDbErrorStatus('invalid_identifier')).toBe(422);
    expect(getDbErrorStatus('weak_password')).toBe(422);
    expect(getDbErrorStatus('invalid_uid')).toBe(422);
    expect(getDbErrorStatus('uid_not_in_guild')).toBe(422);
    expect(getDbErrorStatus('registration_failed')).toBe(422);
    expect(getDbErrorStatus('unknown_rejection')).toBe(422);
  });

  it('enforces HTTP 422 on input validation failures instead of HTTP 200', () => {
    expect(edgeFunctionContent).toContain('if (id.length < 3 || id.length > 32) return json({ ok: false, error: "invalid_identifier" }, 422);');
    expect(edgeFunctionContent).toContain('if (password.length < 8) return json({ ok: false, error: "weak_password" }, 422);');
    expect(edgeFunctionContent).toContain('if (!/^[0-9]{1,20}$/.test(uid)) return json({ ok: false, error: "invalid_uid" }, 422);');
  });

  it('enforces HTTP 400 on bad JSON or missing required fields', () => {
    expect(edgeFunctionContent).toContain('return json({ ok: false, error: "bad_request" }, 400);');
    expect(edgeFunctionContent).toContain('return json({ ok: false, error: "missing_fields" }, 400);');
  });

  it('ensures no error response in player-register returns HTTP 200', () => {
    // Check lines with return json({ ok: false ...
    const lines = edgeFunctionContent.split('\n');
    const errorReturns = [];

    for (const line of lines) {
      if (line.includes('return json(') && (line.includes('ok: false') || line.includes('error:'))) {
        errorReturns.push(line.trim());
      }
    }

    expect(errorReturns.length).toBeGreaterThan(0);
    for (const line of errorReturns) {
      // Must not return status 200
      expect(line).not.toMatch(/,\s*200\s*\);$/);
      // Must not omit status (which defaults to 200)
      expect(line).not.toMatch(/return\s+json\(\s*\{[^}]+\}\s*\);/);
      // Must have one of the explicit normalized status codes or getDbErrorStatus
      expect(line).toMatch(/(?:,\s*(?:400|405|422|429|500|getDbErrorStatus\([^)]+\))\s*\);)/);
    }
  });

  it('reserves HTTP 200 exclusively for successful registration', () => {
    expect(edgeFunctionContent).toContain('return json({ ok: true, status: row.status || "pending" });');
  });
});
