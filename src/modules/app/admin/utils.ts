/**
 * src/modules/app/admin/utils.ts — tiny shared helpers for the admin modules.
 * Call-time window/localStorage access so the classic app.js and tests keep
 * working (test stubs included).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { escapeHTML } from '../../../core/utils/text';

export function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

export function gm(): any {
  return winAny().GM;
}

export function t(key: string): string {
  const g = gm();
  return g && typeof g.t === 'function' ? g.t(key) : key;
}

export function esc(value: unknown): string {
  return escapeHTML(value);
}

export function getDb(): any {
  const g = gm();
  return g && g.db ? g.db : null;
}

export function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id) as T | null;
}
