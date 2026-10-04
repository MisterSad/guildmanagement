/**
 * src/core/config/event-coeff-labels.ts
 *
 * The "· coeff. N×" label on each event page, filled in from the guild's own
 * weights. It was hard-coded in index.html (SvS 5×, GvG 5×, DTR 2×), so a
 * guild that changed its weights in "Guild Configuration & Event
 * Coefficients" saw numbers its Stats page did not use.
 */

import { getGuildConfig } from './guild-config';
import { DEFAULT_EVENT_COEFFS, EVENT_COEFF_CONFIG_KEYS, type EventCoeffBucket } from './event-coeffs';

/** A stored weight, or the default when missing or outside the form's 0-20. */
export function resolveCoeff(bucket: EventCoeffBucket, raw: unknown): number {
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(n) || n < 0 || n > 20) {
    return DEFAULT_EVENT_COEFFS[bucket];
  }
  return n;
}

export async function paintEventCoeffLabels(root: ParentNode = document): Promise<void> {
  const els = Array.from(root.querySelectorAll<HTMLElement>('[data-gm-event-coeff]'));
  await Promise.all(
    els.map(async (el) => {
      const bucket = el.getAttribute('data-gm-event-coeff') as EventCoeffBucket;
      if (!(bucket in EVENT_COEFF_CONFIG_KEYS)) return;
      try {
        const value = resolveCoeff(bucket, await getGuildConfig(EVENT_COEFF_CONFIG_KEYS[bucket]));
        el.textContent = '· coeff. ' + value + '×';
      } catch (_) {
        /* keep what is shown */
      }
    })
  );
}
