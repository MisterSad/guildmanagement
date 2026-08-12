/**
 * src/modules/overview/views/OverviewView.ts
 *
 * Modular Command Center Overview view component.
 */

import { BaseComponent } from '../../../components/ui/BaseComponent';
import { escapeHTML } from '../../../core/api/supabase';

export interface OverviewViewProps {
  guildName: string;
  totalPower: number;
  activeMembersCount: number;
  activeEventsCount: number;
}

export class OverviewView extends BaseComponent<OverviewViewProps, {}> {
  constructor(props: OverviewViewProps) {
    super(props, {});
  }

  protected template(): string {
    const { guildName, totalPower, activeMembersCount, activeEventsCount } = this.props;

    return `
      <div class="gm-overview-container slide-up">
        <div class="overview-header" style="margin-bottom: 1.5rem;">
          <h2 style="font-size: 1.5rem; font-weight: 700; color: var(--fg);">Command Center — ${escapeHTML(guildName)}</h2>
          <p style="color: var(--fg-dim); font-size: 0.9rem;">Real-time guild power & active operations status</p>
        </div>

        <div class="gm-stats-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
          <div class="stat-card" style="background: var(--bg-1); padding: 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--border-soft);">
            <div style="font-size: 0.8rem; color: var(--fg-dim); text-transform: uppercase;">Total Combat Power</div>
            <div style="font-size: 1.75rem; font-weight: 700; color: var(--accent); margin-top: 0.25rem;">${totalPower.toLocaleString()}</div>
          </div>
          <div class="stat-card" style="background: var(--bg-1); padding: 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--border-soft);">
            <div style="font-size: 0.8rem; color: var(--fg-dim); text-transform: uppercase;">Active Members</div>
            <div style="font-size: 1.75rem; font-weight: 700; color: #10b981; margin-top: 0.25rem;">${activeMembersCount}</div>
          </div>
          <div class="stat-card" style="background: var(--bg-1); padding: 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--border-soft);">
            <div style="font-size: 0.8rem; color: var(--fg-dim); text-transform: uppercase;">Active Operations</div>
            <div style="font-size: 1.75rem; font-weight: 700; color: #f59e0b; margin-top: 0.25rem;">${activeEventsCount}</div>
          </div>
        </div>
      </div>
    `;
  }
}
