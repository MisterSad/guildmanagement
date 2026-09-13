/**
 * src/core/auth/webauthn.service.ts
 *
 * Strangler Phase 1 port of the root `gm-webauthn.js` (602 lines): hand-rolled
 * WebAuthn client marshalling between the browser's ArrayBuffer API and the
 * base64url JSON shapes expected by the server's @simplewebauthn/server
 * (Edge Function `auth-passkey`).
 *
 * Strict invariants:
 *   - NotAllowedError / null credential ⇒ { ok:false, error:'cancelled' }.
 *   - Missing platform support ⇒ 'webauthn_unsupported'.
 *   - Conditional mediation keeps its AbortController signal.
 *   - `invoke()` routes through `auth-passkey` and recovers the real body via
 *     `GM.parseFunctionsInvokeResult` (non-2xx).
 *
 * This module never assigns `window.GM.webauthn` (bridge added at cutover).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WebAuthnResult {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

function navAny(): any {
  return (typeof navigator !== 'undefined' ? navigator : ({} as any)) as any;
}

// ── Binary marshalling ───────────────────────────────────────────────────────
export function base64UrlToBuffer(base64url: string): ArrayBuffer {
  const padded = String(base64url).replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + '='.repeat(padLen));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Converts PublicKeyCredentialCreationOptionsJSON → browser create() options. */
export function registrationOptionsFromServer(options: any): any {
  const publicKey = Object.assign({}, options);
  publicKey.challenge = base64UrlToBuffer(options.challenge);
  publicKey.user = Object.assign({}, options.user, { id: base64UrlToBuffer(options.user.id) });
  if (Array.isArray(options.excludeCredentials)) {
    publicKey.excludeCredentials = options.excludeCredentials.map((c: any) =>
      Object.assign({}, c, { id: base64UrlToBuffer(c.id) })
    );
  }
  return publicKey;
}

/** Converts a created PublicKeyCredential → RegistrationResponseJSON. */
export function registrationCredentialToJSON(credential: any): any {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined
    },
    clientExtensionResults: typeof credential.getClientExtensionResults === 'function'
      ? credential.getClientExtensionResults()
      : {},
    type: credential.type
  };
}

/** Converts PublicKeyCredentialRequestOptionsJSON → browser get() options. */
export function authenticationOptionsFromServer(options: any): any {
  const publicKey = Object.assign({}, options);
  publicKey.challenge = base64UrlToBuffer(options.challenge);
  if (Array.isArray(options.allowCredentials)) {
    publicKey.allowCredentials = options.allowCredentials.map((c: any) =>
      Object.assign({}, c, { id: base64UrlToBuffer(c.id) })
    );
  }
  return publicKey;
}

/** Converts an asserted PublicKeyCredential → AuthenticationResponseJSON. */
export function authenticationCredentialToJSON(credential: any): any {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined
    },
    clientExtensionResults: typeof credential.getClientExtensionResults === 'function'
      ? credential.getClientExtensionResults()
      : {},
    type: credential.type
  };
}

// ── Edge invocation ──────────────────────────────────────────────────────────
function invoke(action: string, payload?: Record<string, any>): Promise<WebAuthnResult> {
  const supabase = gm() && gm().db ? gm().db : null;
  if (!supabase) return Promise.resolve({ ok: false, error: 'no_client' });
  return supabase.functions.invoke('auth-passkey', {
    body: { action, payload: payload || {} }
  }).then((r: any) => {
    // parseFunctionsInvokeResult recovers the real {ok,error} body even when the
    // platform gateway rejected the request with a non-2xx status.
    const g = gm();
    if (g && typeof g.parseFunctionsInvokeResult === 'function') {
      return g.parseFunctionsInvokeResult(r);
    }
    return (r && r.data) || { ok: false, error: (r && r.error && r.error.message) || 'request_failed' };
  }).catch(() => ({ ok: false, error: 'request_failed' }));
}

function defaultDeviceLabel(): string {
  const g = gm();
  const env = g && typeof g.detectClientEnvironment === 'function'
    ? g.detectClientEnvironment()
    : { os: 'Unknown OS', browser: 'Unknown Browser' };
  return env.browser + ' on ' + env.os;
}

// ── Ceremonies ───────────────────────────────────────────────────────────────
export function isSupported(): boolean {
  const w = winAny();
  return !!(w.PublicKeyCredential && navAny().credentials && navAny().credentials.create);
}

export async function registerPasskey(deviceLabel?: string): Promise<WebAuthnResult> {
  if (!isSupported()) return { ok: false, error: 'webauthn_unsupported' };

  const optionsRes = await invoke('register-options', {});
  if (!optionsRes.ok) return optionsRes;

  let credential: any;
  try {
    credential = await navAny().credentials.create({
      publicKey: registrationOptionsFromServer(optionsRes.options)
    });
  } catch (err: any) {
    return { ok: false, error: (err && err.name === 'NotAllowedError') ? 'cancelled' : 'create_failed' };
  }
  if (!credential) return { ok: false, error: 'cancelled' };

  return invoke('register-verify', {
    credential: registrationCredentialToJSON(credential),
    device_label: (deviceLabel && deviceLabel.trim()) || defaultDeviceLabel()
  });
}

export async function authenticateWithPasskey(id?: string): Promise<WebAuthnResult> {
  if (!isSupported()) return { ok: false, error: 'webauthn_unsupported' };
  const trimmedId = (id && id.trim()) || '';

  const optionsRes = await invoke('auth-options', { id: trimmedId });
  if (!optionsRes.ok) return optionsRes;

  let credential: any;
  try {
    credential = await navAny().credentials.get({
      publicKey: authenticationOptionsFromServer(optionsRes.options)
    });
  } catch (err: any) {
    return { ok: false, error: (err && err.name === 'NotAllowedError') ? 'cancelled' : 'get_failed' };
  }
  if (!credential) return { ok: false, error: 'cancelled' };

  return invoke('auth-verify', {
    id: trimmedId,
    credential: authenticationCredentialToJSON(credential)
  });
}

export function redeemBackupCode(id: string, code: string): Promise<WebAuthnResult> {
  return invoke('backup-login', { id, code });
}

export function listPasskeys(_accountId?: string): Promise<WebAuthnResult> {
  return invoke('list', {});
}

export function renamePasskey(id: string, deviceLabel: string): Promise<WebAuthnResult> {
  return invoke('rename', { id, device_label: deviceLabel });
}

export function removePasskey(id: string): Promise<WebAuthnResult> {
  return invoke('remove', { id });
}

export function regenerateBackupCodes(_accountId?: string): Promise<WebAuthnResult> {
  return invoke('regenerate-backup-codes', {});
}

export function adminResetPasskeys(id: string): Promise<WebAuthnResult> {
  return invoke('admin-reset-passkeys', { id });
}

// ── Conditional (autofill) ceremony ──────────────────────────────────────────
let conditionalAbortController: AbortController | null = null;

export async function isConditionalMediationAvailable(): Promise<boolean> {
  try {
    const PKC = winAny().PublicKeyCredential;
    return !!(PKC &&
      typeof PKC.isConditionalMediationAvailable === 'function' &&
      await PKC.isConditionalMediationAvailable());
  } catch (err) {
    return false;
  }
}

export function abortConditionalAuth(): void {
  if (conditionalAbortController) {
    conditionalAbortController.abort();
    conditionalAbortController = null;
  }
}

export async function startConditionalAuth(_onSuccess?: (accId: string) => void): Promise<WebAuthnResult | null> {
  if (!isSupported()) return null;
  const available = await isConditionalMediationAvailable();
  if (!available) return null;

  abortConditionalAuth();
  const controller = new AbortController();
  conditionalAbortController = controller;

  const optionsRes = await invoke('auth-options', { id: '' });
  if (!optionsRes.ok) return null;

  let credential: any;
  try {
    credential = await navAny().credentials.get({
      publicKey: authenticationOptionsFromServer(optionsRes.options),
      mediation: 'conditional',
      signal: controller.signal
    });
  } catch (err) {
    return null; // aborted (superseded) or dismissed — not an error to surface
  }
  if (!credential || controller.signal.aborted) return null;

  return invoke('auth-verify', {
    id: '',
    credential: authenticationCredentialToJSON(credential)
  });
}

/** Aggregated service object (bridged to `window.GM.webauthn` at cutover). */
export const webAuthnService = {
  isSupported,
  registerPasskey,
  authenticateWithPasskey,
  redeemBackupCode,
  listPasskeys,
  renamePasskey,
  removePasskey,
  regenerateBackupCodes,
  adminResetPasskeys,
  isConditionalMediationAvailable,
  startConditionalAuth,
  abortConditionalAuth
};

export default webAuthnService;
