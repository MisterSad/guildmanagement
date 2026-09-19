# ADR-013: WCAG 2.2 AA Modal Dialog Accessibility & Focus Trap

- **Status**: Accepted
- **Date**: 2026-09-20
- **Authors**: Lead Architect & SecOps

---

## 1. Context

Accessibility auditing (`[CONST-D12-01]`) identified critical gaps in modal dialog implementations across the PWA:
1. **Focus Loss (WCAG 2.4.3 Focus Order)**: When closing a dialog via Cancel or Escape, focus was dropped to `document.body` rather than returned to the triggering button.
2. **Focus Escaping**: Pressing `Tab` or `Shift+Tab` allowed keyboard navigation to escape modal dialogs into the underlying page content.
3. **Screen Reader Bleed-Through**: The background DOM (`#app`) remained visible to assistive technologies while modals were open.
4. **Semantic Role Confusion (WCAG 4.1.2 Name, Role, Value)**: Destructive confirmations used generic `role="dialog"` instead of `role="alertdialog"`.
5. **Unlabeled Controls**: Icon-only action buttons in `index.html` lacked accessible text names.

## 2. Decision

We upgraded `src/components/ui/Dialog.ts` and `index.html` to achieve strict WCAG 2.2 Level AA compliance:
1. **Focus Capture & Restoration**:
   - Captured `previouslyFocused = document.activeElement` before dialog display.
   - Restored focus to `previouslyFocused` on dialog dismissal if still connected to the DOM.
2. **Dynamic Semantic Roles**:
   - `role="alertdialog"` applied when `tone === 'danger'`, alerting screen readers of urgent, destructive confirmations.
   - `role="dialog"` applied for standard modals.
   - Linked via `aria-modal="true"`, `aria-labelledby="dialog-title-{id}"`, and optional `aria-describedby="dialog-subtitle-{id}"`.
3. **Background Inertness**:
   - Automatically toggled `aria-hidden="true"` on `#app` when any dialog opens, removing background elements from the accessibility tree.
   - Removed `aria-hidden` upon dialog close.
4. **Bidirectional Keyboard Focus Trap**:
   - Intercepted `Tab` and `Shift+Tab` events to cycle focus strictly within focusable elements inside the dialog card.
5. **Accessible Button Names**:
   - Added explicit `aria-label` attributes to icon buttons (`#logout-btn`, `#ocr-modal-close`, and all 6 `data-custom-msg` buttons).
   - Added `aria-hidden="true"` to decorative Phosphor icons.

## 3. Consequences & Invariants

- **Full Keyboard Operability**: Every modal dialog can be navigated with `Tab`/`Shift+Tab` and dismissed with `Escape`.
- **Screen Reader Parity**: Assistive technology users receive immediate alert announcements on destructive actions.
