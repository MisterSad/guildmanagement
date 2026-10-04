/**
 * src/modules/app/admin/utils.ts — tiny shared helpers for the admin modules.
 * Translation, escaping and the Supabase client come from their typed modules;
 * only localStorage and the DOM are reached at call time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { escapeHTML } from '../../../core/utils/text';
import { t as translate } from '../../../core/i18n/i18n';
import { getClient } from '../../../core/api/supabase';

export function t(key: string): string {
  return translate(key);
}

export function esc(value: unknown): string {
  return escapeHTML(value);
}

export function getDb(): any {
  return getClient();
}

export function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id) as T | null;
}
