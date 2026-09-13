/**
 * tests/webauthn_service.test.js
 *
 * Phase 1 behavioural suite for src/core/auth/webauthn.service.ts in jsdom.
 * The legacy root `gm-webauthn.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  registrationOptionsFromServer,
  registrationCredentialToJSON,
  authenticationOptionsFromServer,
  authenticationCredentialToJSON,
  webAuthnService,
  abortConditionalAuth
} from '../src/core/auth/webauthn.service';

const enc = (s) => new TextEncoder().encode(s).buffer;

let invokeMock;
let createMock;
let getMock;

function installGM() {
  invokeMock = vi.fn(async (_fn, opts) => {
    const action = opts.body.action;
    if (action === 'register-options') {
      return { data: { ok: true, options: { challenge: 'AQID', user: { id: 'BAUG' }, excludeCredentials: [] } }, error: null };
    }
    if (action === 'auth-options') {
      return { data: { ok: true, options: { challenge: 'AQID', allowCredentials: [{ id: 'BAUG' }] } }, error: null };
    }
    return { data: { ok: true }, error: null };
  });
  window.GM = {
    db: { functions: { invoke: invokeMock } },
    parseFunctionsInvokeResult: (r) => (r && r.data) || { ok: false, error: 'request_failed' },
    detectClientEnvironment: () => ({ os: 'TestOS', browser: 'TestBrowser' }),
    showToast: vi.fn()
  };
}

function mkCredential(kind) {
  const base = { rawId: enc('raw'), type: 'public-key', getClientExtensionResults: () => ({}) };
  if (kind === 'registration') {
    return {
      ...base,
      id: 'cred-id',
      response: { clientDataJSON: enc('client'), attestationObject: enc('att'), getTransports: () => ['internal'] }
    };
  }
  return {
    ...base,
    id: 'cred-id',
    response: { clientDataJSON: enc('client'), authenticatorData: enc('auth'), signature: enc('sig'), userHandle: null }
  };
}

function installCredentials() {
  createMock = vi.fn(async () => mkCredential('registration'));
  getMock = vi.fn(async () => mkCredential('authentication'));
  window.PublicKeyCredential = function PublicKeyCredential() {};
  window.PublicKeyCredential.isConditionalMediationAvailable = vi.fn(async () => true);
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: createMock, get: getMock }
  });
}

afterEach(() => {
  abortConditionalAuth();
  delete window.GM;
  delete window.PublicKeyCredential;
  delete navigator.credentials;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('WebAuthn binary marshalling', () => {
  it('round-trips base64url ↔ ArrayBuffer without padding', () => {
    const b64 = bufferToBase64Url(enc('hello world'));
    expect(b64).toBe('aGVsbG8gd29ybGQ');
    const bytes = new Uint8Array(base64UrlToBuffer(b64));
    expect(Array.from(bytes)).toEqual(Array.from(new Uint8Array(enc('hello world'))));
  });

  it('converts server registration options (challenge, user.id, excludeCredentials)', () => {
    const out = registrationOptionsFromServer({ challenge: 'AQID', user: { id: 'BAUG' }, excludeCredentials: [{ id: 'AQID' }] });
    expect(out.challenge).toBeInstanceOf(ArrayBuffer);
    expect(out.user.id).toBeInstanceOf(ArrayBuffer);
    expect(out.excludeCredentials[0].id).toBeInstanceOf(ArrayBuffer);
  });

  it('converts server authentication options (challenge, allowCredentials)', () => {
    const out = authenticationOptionsFromServer({ challenge: 'AQID', allowCredentials: [{ id: 'AQID' }] });
    expect(out.challenge).toBeInstanceOf(ArrayBuffer);
    expect(out.allowCredentials[0].id).toBeInstanceOf(ArrayBuffer);
  });

  it('serializes a registration credential to the server JSON contract', () => {
    const json = registrationCredentialToJSON(mkCredential('registration'));
    expect(json.rawId).toBe(bufferToBase64Url(enc('raw')));
    expect(json.response.clientDataJSON).toBe(bufferToBase64Url(enc('client')));
    expect(json.response.attestationObject).toBe(bufferToBase64Url(enc('att')));
    expect(json.response.transports).toEqual(['internal']);
    expect(json.type).toBe('public-key');
  });

  it('serializes an authentication credential (userHandle optional)', () => {
    const json = authenticationCredentialToJSON(mkCredential('authentication'));
    expect(json.response.authenticatorData).toBe(bufferToBase64Url(enc('auth')));
    expect(json.response.signature).toBe(bufferToBase64Url(enc('sig')));
    expect(json.response.userHandle).toBeUndefined();
  });
});

describe('WebAuthn ceremonies', () => {
  it('reports unsupported when the platform lacks PublicKeyCredential', async () => {
    installGM();
    expect(webAuthnService.isSupported()).toBe(false);
    expect(await webAuthnService.registerPasskey()).toEqual({ ok: false, error: 'webauthn_unsupported' });
  });

  it('registers a passkey end to end and forwards the device label', async () => {
    installGM();
    installCredentials();
    const res = await webAuthnService.registerPasskey('My Laptop');
    expect(res.ok).toBe(true);

    const call = invokeMock.mock.calls.find((c) => c[1].body.action === 'register-verify');
    expect(call).toBeTruthy();
    expect(call[1].body.payload.device_label).toBe('My Laptop');
    expect(call[1].body.payload.credential.rawId).toBe(bufferToBase64Url(enc('raw')));
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('uses the client environment as the default device label', async () => {
    installGM();
    installCredentials();
    await webAuthnService.registerPasskey();
    const call = invokeMock.mock.calls.find((c) => c[1].body.action === 'register-verify');
    expect(call[1].body.payload.device_label).toBe('TestBrowser on TestOS');
  });

  it('maps NotAllowedError to cancelled on registration', async () => {
    installGM();
    installCredentials();
    createMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotAllowedError' }));
    expect(await webAuthnService.registerPasskey()).toEqual({ ok: false, error: 'cancelled' });
  });

  it('authenticates end to end', async () => {
    installGM();
    installCredentials();
    const res = await webAuthnService.authenticateWithPasskey('acc-1');
    expect(res.ok).toBe(true);
    const call = invokeMock.mock.calls.find((c) => c[1].body.action === 'auth-verify');
    expect(call[1].body.payload.id).toBe('acc-1');
    expect(call[1].body.payload.credential.response.signature).toBe(bufferToBase64Url(enc('sig')));
  });

  it('maps NotAllowedError to cancelled on authentication', async () => {
    installGM();
    installCredentials();
    getMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotAllowedError' }));
    expect(await webAuthnService.authenticateWithPasskey('')).toEqual({ ok: false, error: 'cancelled' });
  });

  it('routes backup-code redemption through auth-passkey', async () => {
    installGM();
    installCredentials();
    await webAuthnService.redeemBackupCode('acc-1', 'CODE-123');
    expect(invokeMock).toHaveBeenCalledWith('auth-passkey', { body: { action: 'backup-login', payload: { id: 'acc-1', code: 'CODE-123' } } });
  });
});

describe('WebAuthn conditional mediation', () => {
  it('runs a conditional ceremony passing mediation + signal', async () => {
    installGM();
    installCredentials();
    const res = await webAuthnService.startConditionalAuth();
    expect(res.ok).toBe(true);
    const opts = getMock.mock.calls[0][0];
    expect(opts.mediation).toBe('conditional');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(invokeMock.mock.calls.some((c) => c[1].body.action === 'auth-verify')).toBe(true);
  });

  it('resolves null when conditional mediation is unavailable', async () => {
    installGM();
    installCredentials();
    window.PublicKeyCredential.isConditionalMediationAvailable = vi.fn(async () => false);
    expect(await webAuthnService.startConditionalAuth()).toBeNull();
  });

  it('abortConditionalAuth() cancels an in-flight conditional request', async () => {
    installGM();
    installCredentials();
    getMock.mockImplementation((opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    const pending = webAuthnService.startConditionalAuth();
    await new Promise((r) => setTimeout(r, 0));
    abortConditionalAuth();
    expect(await pending).toBeNull();
  });
});

describe('WebAuthn service — cutover guard', () => {
  it('does not expose window.GM.webauthn', async () => {
    installGM();
    installCredentials();
    await webAuthnService.registerPasskey();
    expect(window.GM.webauthn).toBeUndefined();
  });
});
