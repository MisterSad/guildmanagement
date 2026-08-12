/**
 * src/modules/sanctions/views/SanctionsView.ts
 *
 * Modular Sanctions Management view component.
 */

import { BaseComponent } from '../../../components/ui/BaseComponent';
import { escapeHTML } from '../../../core/api/supabase';

export interface SanctionItem {
  pseudo: string;
  unexcusedAbsences: number;
  sanctionLevel: 'Warning' | 'Demotion' | 'Kick';
}

export interface SanctionsViewProps {
  sanctions: SanctionItem[];
}

export class SanctionsView extends BaseComponent<SanctionsViewProps, {}> {
  constructor(props: SanctionsViewProps) {
    super(props, {});
  }

  protected template(): string {
    const { sanctions } = this.props;

    if (!sanctions || sanctions.length === 0) {
      return `
        <div class="gm-empty" style="padding: 3rem; text-align: center;">
          <i class="ph ph-shield-check" style="font-size: 2.5rem; color: #10b981;"></i>
          <div style="margin-top: 0.5rem; color: var(--fg-dim);">No active sanctions for guild members.</div>
        </div>
      `;
    }

    const rows = sanctions
      .map((s) => {
        const badgeColor = s.sanctionLevel === 'Kick' ? '#ef4444' : s.sanctionLevel === 'Demotion' ? '#f59e0b' : '#3b82f6';
        return `
          <div class="sanction-item" style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: var(--bg-1); border-radius: var(--radius-md); border: 1px solid var(--border-soft); margin-bottom: 0.5rem;">
            <div>
              <div style="font-weight: 600; color: var(--fg);">${escapeHTML(s.pseudo)}</div>
              <div style="font-size: 0.8rem; color: var(--fg-dim);">${s.unexcusedAbsences} unexcused absences</div>
            </div>
            <span class="gm-sanction-badge" style="background: ${badgeColor}; color: #fff; padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">
              ${escapeHTML(s.sanctionLevel)}
            </span>
          </div>
        `;
      })
      .join('');

    return `
      <div class="gm-sanctions-view slide-up">
        <h3 style="margin-bottom: 1rem; color: var(--fg);">Guild Sanctions</h3>
        <div class="sanctions-list">${rows}</div>
      </div>
    `;
  }
}
