/**
 * src/components/ui/types.ts
 *
 * Shared variant enums for the modular UI component library
 * (shadcn/ui philosophy, ported to this vanilla TypeScript stack).
 */

/** Sizing scale shared by every gm-ui-* component. */
export type UiSize = 'sm' | 'md';

/**
 * Event/semantic accent mapped to the M3 token palette:
 * 'default' falls back to --gm-event-gvg (the UI accent), then the FGF
 * event tones (SvS, GvG, Glory, Arms Race, Shadowfront, DTR) and 'danger'.
 */
export type UiAccent =
  | 'default'
  | 'svs'
  | 'gvg'
  | 'glory'
  | 'armsrace'
  | 'shadowfront'
  | 'dtr'
  | 'danger';

/** Interaction state shared by toggles and inputs. */
export type UiState = 'idle' | 'checked' | 'disabled' | 'indeterminate';