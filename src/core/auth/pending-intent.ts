/**
 * src/core/auth/pending-intent.ts
 *
 * What a person was doing when they left for Discord, so they find it again
 * when they come back.
 *
 * Discord sign-in is a full-page redirect (COOP severs window.opener, so no
 * popup), and the auth-discord callback always returns to the app root with
 * nothing but a ticket. Anything the person had already chosen -- "join a
 * guild", the join code, their UID -- would be lost across that round trip.
 * It is kept here, in sessionStorage: same tab, survives the redirect, gone
 * when the tab closes, never sent anywhere.
 *
 * NEVER a secret. The type has no password field, and `savePendingIntent`
 * copies only the whitelisted fields, so a caller cannot smuggle one in.
 * Join and invite codes are shared secrets of a weaker kind (a code alone is
 * never redeemable: it is always spent together with a fresh Discord
 * authorization), and they already sit in the person's clipboard or chat.
 */

export type PendingIntentKind = 'join' | 'code' | 'claim' | 'create';

export interface PendingIntent {
  kind: PendingIntentKind;
  /** Guild join code (join) or invitation/relink code (code). */
  code?: string;
  /** In-game UID (join). */
  uid?: string;
  /** Account identifier (claim). Never the password. */
  accountId?: string;
  guildTag?: string;
  serverNumber?: string;
  /** Set when the intent came from a shared link rather than a restart. */
  fromLink?: boolean;
  /** Epoch ms when it was saved. */
  ts: number;
}

const KEY = 'gm_pending_intent';
/** Long enough for a Discord consent screen and a slow typist; short enough to go stale. */
export const PENDING_INTENT_TTL_MS = 30 * 60_000;

const KINDS: readonly PendingIntentKind[] = ['join', 'code', 'claim', 'create'];

// The bounds of the auth-discord Zod schemas, so a value that would be refused
// server-side is refused here, before it is ever stored or pre-filled.
const PATTERNS: Record<string, RegExp> = {
  joinCode: /^[A-Za-z0-9_-]{1,64}$/,
  linkCode: /^[A-Za-z0-9-]{4,128}$/,
  uid: /^[0-9]{1,20}$/,
  accountId: /^[^\s<>"'&]{1,128}$/,
  guildTag: /^[A-Za-z0-9_]{2,12}$/,
  serverNumber: /^[0-9]{4}$/,
};

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function clean(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v && pattern.test(v) ? v : undefined;
}

/** Normalises an untrusted object into an intent, dropping anything invalid. */
export function sanitizeIntent(raw: unknown, now: number = Date.now()): PendingIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as PendingIntentKind;
  if (!KINDS.includes(kind)) return null;
  const intent: PendingIntent = { kind, ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : now };
  const code = clean(r.code, kind === 'join' ? PATTERNS.joinCode : PATTERNS.linkCode);
  if (code && (kind === 'join' || kind === 'code')) intent.code = code;
  const uid = clean(r.uid, PATTERNS.uid);
  if (uid && kind === 'join') intent.uid = uid;
  const accountId = clean(r.accountId, PATTERNS.accountId);
  if (accountId && kind === 'claim') intent.accountId = accountId;
  const guildTag = clean(r.guildTag, PATTERNS.guildTag);
  if (guildTag && kind === 'create') intent.guildTag = guildTag.toUpperCase();
  const serverNumber = clean(r.serverNumber, PATTERNS.serverNumber);
  if (serverNumber && kind === 'create') intent.serverNumber = serverNumber;
  if (r.fromLink === true) intent.fromLink = true;
  return intent;
}

/** Stores an intent, overwriting any previous one. Silently a no-op without storage. */
export function savePendingIntent(intent: Omit<PendingIntent, 'ts'> & { ts?: number }): void {
  const safe = sanitizeIntent({ ...intent, ts: intent.ts ?? Date.now() });
  const s = storage();
  if (!safe || !s) return;
  try { s.setItem(KEY, JSON.stringify(safe)); } catch { /* quota or blocked storage */ }
}

/** Reads the current intent without consuming it. Expired or malformed ones are dropped. */
export function peekPendingIntent(now: number = Date.now()): PendingIntent | null {
  const s = storage();
  if (!s) return null;
  let raw: string | null = null;
  try { raw = s.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through */ }
  const intent = sanitizeIntent(parsed, now);
  if (!intent || now - intent.ts > PENDING_INTENT_TTL_MS || intent.ts > now + 60_000) {
    clearPendingIntent();
    return null;
  }
  return intent;
}

export function clearPendingIntent(): void {
  const s = storage();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* blocked storage */ }
}

// ── Shared invite links ─────────────────────────────────────────────────────
//
// `https://<app>/#join=<guild join code>` and `https://<app>/#code=<invite or
// relink code>`. The FRAGMENT, never the query string: a fragment is not sent
// to Vercel, to Supabase or in a Referer header, so the code never lands in an
// access log. It is read once at boot, stored as a pending intent, and
// stripped from the address bar before anything else runs.

const LINK_KEYS: Record<string, PendingIntentKind> = { join: 'join', code: 'code' };

/** Builds a shareable link for a join code or an invitation/relink code. */
export function buildInviteLink(origin: string, kind: 'join' | 'code', code: string): string {
  return origin.replace(/\/+$/, '') + '/#' + kind + '=' + encodeURIComponent(code.trim());
}

/**
 * Reads `#join=` / `#code=` from the current URL, stores it as a pending
 * intent and removes it from the address bar. Returns the intent, or null when
 * the fragment carries none (or carries an invalid one, which is dropped).
 */
export function captureIntentFromHash(): PendingIntent | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const hash = window.location.hash || '';
  const m = /^#(join|code)=([^&]*)$/.exec(hash);
  if (!m) return null;

  // Strip first: whatever happens next, the code must not stay in the address
  // bar, the history entry or a bookmark.
  try {
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
  } catch { /* replaceState unavailable in some embedded webviews */ }

  let code = '';
  try { code = decodeURIComponent(m[2]); } catch { return null; }
  const intent = sanitizeIntent({ kind: LINK_KEYS[m[1]], code, fromLink: true });
  if (!intent || !intent.code) return null;
  savePendingIntent(intent);
  return intent;
}
