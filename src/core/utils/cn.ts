/**
 * src/core/utils/cn.ts
 *
 * Canonical class-name combiner (shadcn/ui philosophy).
 * - clsx resolves conditional/overriding inputs (strings, objects, arrays,
 *   falsy values — no pre-joining required).
 * - tailwind-merge resolves conflicting utility classes right-to-left
 *   (last-wins). Works standalone: twMerge's conflict resolution is
 *   data-driven, no Tailwind pipeline required.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export type { ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}