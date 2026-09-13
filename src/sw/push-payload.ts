/**
 * src/sw/push-payload.ts
 *
 * Pure, dependency-free parser for the Web Push message payload consumed by the
 * service worker. Extracted from the legacy root `sw.js` so its JSON/text
 * fallback behaviour can be unit-tested without a `ServiceWorkerGlobalScope`.
 *
 * This module has no side effects: it never touches `self`, `caches` or the
 * network.
 */

export const DEFAULT_PUSH_TITLE = 'FGF Guild Management';
export const DEFAULT_PUSH_TAG = 'fgf-event';
export const DEFAULT_PUSH_URL = '/';

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/**
 * Minimal structural view of `PushMessageData` (the object exposed as
 * `PushEvent.data`). Declared locally to avoid pulling in `lib.webworker`,
 * which conflicts with the project's DOM lib setup.
 */
export interface PushMessageDataLike {
  json(): unknown;
  text(): string;
}

/** Mirrors the legacy `data.x || fallback` truthiness semantics. */
function pick(value: unknown, fallback: string): string {
  return value ? String(value) : fallback;
}

/**
 * Parses a push event payload into the shape used to build the notification.
 *
 * - Valid JSON object: read `title`/`body`/`tag`/`url`, falling back per field.
 * - Malformed JSON / non-object: fall back to the raw text as the body with the
 *   default title (legacy behaviour).
 * - Missing payload entirely: every field falls back to its default.
 */
export function parsePushPayload(data: PushMessageDataLike | null | undefined): PushPayload {
  let raw: Record<string, unknown> = {};

  if (data) {
    try {
      const parsed = data.json();
      if (parsed && typeof parsed === 'object') {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = { title: DEFAULT_PUSH_TITLE, body: data.text() };
    }
  }

  return {
    title: pick(raw.title, DEFAULT_PUSH_TITLE),
    body: pick(raw.body, ''),
    tag: pick(raw.tag, DEFAULT_PUSH_TAG),
    url: pick(raw.url, DEFAULT_PUSH_URL),
  };
}