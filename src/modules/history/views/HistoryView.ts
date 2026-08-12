/**
 * src/modules/history/views/HistoryView.ts
 *
 * Modular Session History view component.
 */

import { BaseComponent } from '../../../components/ui/BaseComponent';
import { escapeHTML } from '../../../core/api/supabase';

export interface HistorySessionItem {
  sessionId: string;
  eventName: string;
  startAt: string;
  participantCount: number;
}

export interface HistoryViewProps {
  sessions: HistorySessionItem[];
}

export class HistoryView extends BaseComponent<HistoryViewProps, {}> {
  constructor(props: HistoryViewProps) {
    super(props, {});
  }

  protected template(): string {
    const { sessions } = this.props;

    if (!sessions || sessions.length === 0) {
      return `
        <div class="gm-empty" style="padding: 3rem; text-align: center;">
          <i class="ph ph-clock-counter-clockwise" style="font-size: 2.5rem; color: var(--fg-dim);"></i>
          <div style="margin-top: 0.5rem; color: var(--fg-dim);">No past event sessions recorded.</div>
        </div>
      `;
    }

    const rows = sessions
      .map(
        (s) => `
        <div class="history-item" style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: var(--bg-1); border-radius: var(--radius-md); border: 1px solid var(--border-soft); margin-bottom: 0.5rem;">
          <div>
            <div style="font-weight: 600; color: var(--fg);">${escapeHTML(s.eventName)}</div>
            <div style="font-size: 0.8rem; color: var(--fg-dim); font-family: monospace;">${escapeHTML(s.sessionId)} • ${escapeHTML(new Date(s.startAt).toLocaleDateString())}</div>
          </div>
          <div class="gm-badge" style="background: var(--bg-2); padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.8rem;">
            ${s.participantCount} participants
          </div>
        </div>
      `
      )
      .join('');

    return `
      <div class="gm-history-view slide-up">
        <h3 style="margin-bottom: 1rem; color: var(--fg);">Event Session History</h3>
        <div class="history-list">${rows}</div>
      </div>
    `;
  }
}
