import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock @sentry/browser
const mockInit = vi.fn();
const mockCaptureException = vi.fn().mockReturnValue('event_123');

vi.mock('@sentry/browser', () => ({
  init: (...args) => mockInit(...args),
  captureException: (...args) => mockCaptureException(...args),
}));

import {
  initSentry,
  captureException,
  isSentryInitialized,
  _resetSentryForTesting,
  scrubText,
  scrubData,
  scrubSentryEvent,
} from '../src/core/monitoring/sentry';

describe('TICKET-05 [OBS-02]: Sentry Browser Monitoring & PII Scrubbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSentryForTesting();
  });

  describe('Initialization', () => {
    it('does not initialize Sentry when no DSN is provided', async () => {
      const result = await initSentry({ dsn: '' });
      expect(result).toBe(false);
      expect(isSentryInitialized()).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('initializes Sentry when a valid DSN is provided', async () => {
      const testDsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';
      const result = await initSentry({ dsn: testDsn, release: 'V3.19.0', environment: 'production' });

      expect(result).toBe(true);
      expect(isSentryInitialized()).toBe(true);
      expect(mockInit).toHaveBeenCalledTimes(1);

      const initConfig = mockInit.mock.calls[0][0];
      expect(initConfig.dsn).toBe(testDsn);
      expect(initConfig.release).toBe('V3.19.0');
      expect(initConfig.environment).toBe('production');
      expect(typeof initConfig.beforeSend).toBe('function');
      expect(initConfig.sendDefaultPii).toBe(false);
    });

    it('is idempotent on multiple initSentry calls', async () => {
      const testDsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';
      await Promise.all([initSentry({ dsn: testDsn }), initSentry({ dsn: testDsn })]);
      await initSentry({ dsn: testDsn });
      expect(mockInit).toHaveBeenCalledTimes(1);
    });
  });

  describe('PII & Secret Scrubbing', () => {
    it('redacts JWT tokens and Bearer credentials from text strings', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature12345';
      const text = `Failed request with Authorization: Bearer ${jwt} and token=${jwt}`;
      const scrubbed = scrubText(text);

      expect(scrubbed).not.toContain(jwt);
      expect(scrubbed).toContain('[REDACTED]');
    });

    it('redacts sensitive keys in nested metadata objects', () => {
      const rawPayload = {
        user: 'Ares',
        auth: {
          password: 'SuperSecretPassword123!',
          gotrue_secret: 'secret_abc',
          session: {
            access_token: 'token_xyz',
            valid: true,
          },
        },
        metadata: {
          guild: 'ALPHA',
        },
      };

      const sanitized = scrubData(rawPayload);
      expect(sanitized.user).toBe('Ares');
      expect(sanitized.auth.password).toBe('[REDACTED]');
      expect(sanitized.auth.gotrue_secret).toBe('[REDACTED]');
      expect(sanitized.auth.session.access_token).toBe('[REDACTED]');
      expect(sanitized.auth.session.valid).toBe(true);
      expect(sanitized.metadata.guild).toBe('ALPHA');
    });

    it('scrubs Sentry event messages, exception values, breadcrumbs and tags', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345';
      const event = {
        message: `Error with token: ${jwt}`,
        exception: {
          values: [
            {
              value: `Crash at login with token: ${jwt}`,
              stacktrace: {
                frames: [
                  {
                    vars: {
                      password: 'rawPassword',
                      publicVar: 42,
                    },
                  },
                ],
              },
            },
          ],
        },
        breadcrumbs: [
          {
            message: `User entered password`,
            data: { secret_code: '123456' },
          },
        ],
        extra: {
          token: jwt,
          info: 'ok',
        },
      };

      const processed = scrubSentryEvent(event);
      expect(processed.message).not.toContain(jwt);
      expect(processed.exception.values[0].value).not.toContain(jwt);
      expect(processed.exception.values[0].stacktrace.frames[0].vars.password).toBe('[REDACTED]');
      expect(processed.exception.values[0].stacktrace.frames[0].vars.publicVar).toBe(42);
      expect(processed.breadcrumbs[0].data.secret_code).toBe('[REDACTED]');
      expect(processed.extra.token).toBe('[REDACTED]');
      expect(processed.extra.info).toBe('ok');
      expect(processed.tags.app_version).toBeDefined();
    });
  });

  describe('captureException wrapper', () => {
    it('safely skips capture if Sentry is not initialized', () => {
      const result = captureException(new Error('Test error'));
      expect(result).toBeUndefined();
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('captures sanitized exception if Sentry is initialized', async () => {
      await initSentry({ dsn: 'https://key@o0.ingest.sentry.io/0' });
      const err = new Error('Test error');
      const result = captureException(err, { password: 'secret', action: 'test' });

      expect(result).toBe('event_123');
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [calledErr, calledContext] = mockCaptureException.mock.calls[0];
      expect(calledErr).toBe(err);
      expect(calledContext.extra.password).toBe('[REDACTED]');
      expect(calledContext.extra.action).toBe('test');
    });
  });

  describe('errors thrown while the SDK loads (M5)', () => {
    it('are held and reported once Sentry is up', async () => {
      const ready = initSentry({ dsn: 'https://key@o0.ingest.sentry.io/0' });
      const early = new Error('during boot');
      window.dispatchEvent(new ErrorEvent('error', { error: early, message: 'during boot' }));
      await ready;
      expect(mockCaptureException).toHaveBeenCalledWith(early);
    });
  });

  describe('vercel.json CSP configuration', () => {
    it('verifies that vercel.json includes *.ingest.sentry.io in connect-src', () => {
      const vercelPath = path.resolve(__dirname, '../vercel.json');
      expect(fs.existsSync(vercelPath)).toBe(true);

      const vercelConfig = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
      const headers = vercelConfig.headers?.[0]?.headers || [];
      const cspHeader = headers.find((h) => h.key === 'Content-Security-Policy');

      expect(cspHeader).toBeDefined();
      expect(cspHeader.value).toContain('https://*.ingest.sentry.io');
    });
  });
});
