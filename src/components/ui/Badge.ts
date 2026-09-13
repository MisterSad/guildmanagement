/**
 * src/components/ui/Badge.ts
 *
 * Accessible status/score badge (shadcn/ui philosophy).
 * Pure render helpers over cva variants — never positions content, just the
 * tone/style/size recipe. All text is escaped via escapeHTML(); callers pass
 * already i18n-resolved labels.
 */

import { cva } from '../../core/utils/cva';
import { cn } from '../../core/utils/cn';
import { escapeHTML } from '../../core/utils/text';

export type BadgeTone = 'svs' | 'gvg' | 'glory' | 'danger' | 'default' | 'warning' | 'success';
export type BadgeStyle = 'soft' | 'solid' | 'outline' | 'pill';
export type BadgeSize = 'sm' | 'md';
export type WarStatus = 'W' | 'L' | 'tie' | 'pending';

export interface BadgeProps {
  text: string | number;
  tone?: BadgeTone;
  style?: BadgeStyle;
  size?: BadgeSize;
  /** Exact value tooltip (e.g. full score when the badge shows a compact form). */
  title?: string;
  className?: string;
}

export interface WarStatusLabels {
  won?: string;
  lost?: string;
  tie?: string;
  pending?: string;
}

export const badgeRecipe = cva('gm-ui-badge', {
  variants: {
    tone: {
      svs: 'gm-ui-badge-svs',
      gvg: 'gm-ui-badge-gvg',
      glory: 'gm-ui-badge-glory',
      danger: 'gm-ui-badge-danger',
      default: 'gm-ui-badge-default',
      warning: 'gm-ui-badge-warning',
      success: 'gm-ui-badge-success'
    },
    style: {
      soft: 'gm-ui-badge-soft',
      solid: 'gm-ui-badge-solid',
      outline: 'gm-ui-badge-outline',
      pill: 'gm-ui-badge-pill'
    },
    size: {
      sm: 'gm-ui-badge-sm',
      md: 'gm-ui-badge-md'
    }
  },
  defaultVariants: { tone: 'default', style: 'soft', size: 'md' }
});

export function badgeClassList(props: BadgeProps): string {
  return badgeRecipe({ tone: props.tone, style: props.style, size: props.size });
}

export function renderBadge(props: BadgeProps): string {
  const cls = cn(badgeClassList(props), props.className);
  const titleAttr = props.title ? ' title="' + escapeHTML(props.title) + '"' : '';
  return '<span class="' + cn(cls) + '"' + titleAttr + '>' + escapeHTML(props.text) + '</span>';
}

export function createBadge(props: BadgeProps): HTMLSpanElement {
  const host = document.createElement('span');
  host.innerHTML = renderBadge(props);
  return host.firstElementChild as HTMLSpanElement;
}

/**
 * War day status badge ('W' / 'L' / 'tie' / 'pending').
 * Labels are optional: when the caller supplies i18n-resolved text (won/lost/
 * tie/pending), the badge shows the full word (e.g. "Won"); otherwise it falls
 * back to the compact W/L markers.
 */
export function renderWarStatusBadge(outcome: WarStatus, labels?: WarStatusLabels): string {
  const hasLabels = labels && (labels.won || labels.lost || labels.tie || labels.pending);
  const text = outcome === 'W'
    ? (labels?.won ?? 'W')
    : outcome === 'L'
      ? (labels?.lost ?? 'L')
      : outcome === 'tie'
        ? (labels?.tie ?? 'Tie')
        : (labels?.pending ?? 'Pending');
  const tone: BadgeTone = outcome === 'W' ? 'success' : outcome === 'L' ? 'danger' : outcome === 'tie' ? 'default' : 'warning';
  return renderBadge({
    text,
    tone,
    style: 'soft',
    size: 'sm',
    ...(hasLabels ? {} : { title: outcome === 'W' ? 'Won' : outcome === 'L' ? 'Lost' : outcome === 'tie' ? 'Tie' : 'Pending' })
  });
}