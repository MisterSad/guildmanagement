/**
 * src/core/utils/cn.ts
 *
 * Canonical class-name combiner: clsx resolves conditional and nested inputs
 * (strings, objects, arrays, falsy values -- no pre-joining required).
 *
 * It used to run the result through tailwind-merge too. This app has no
 * Tailwind utilities -- every class is a `gm-*` name, which tailwind-merge
 * passes through untouched -- so that was 20 KB of the entry bundle doing
 * nothing (M5). If conflicting utilities ever need resolving, the variant
 * recipes (cva) are where to do it.
 */

import { clsx, type ClassValue } from 'clsx';

export type { ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
