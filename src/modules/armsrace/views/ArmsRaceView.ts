/**
 * src/modules/armsrace/views/ArmsRaceView.ts
 *
 * Strangler Phase 1 port of the legacy root `armsrace.js` (557 lines) to a
 * strict-TypeScript view module. This file is NOT bridged onto
 * `window.GM_ARMSRACE` during Phase 1 (the legacy script still owns that global
 * until cutover): it is exercised by `tests/armsrace_view.test.js`.
 *
 * Architecture:
 *   - Pure helpers (event names, labels, filtering, sorting, RPC payloads,
 *     stat counters) live in `armsrace.service.ts`.
 *   - Shared helpers (i18n, toasts, dates, Discord, the Supabase client,
 *     dialogs) are typed imports; nothing is read from `window`.
 *   - `load()` always renders, even on network error, so the panel is never
 *     left blank.
 *   - This module never assigns any `window.GM_*` variable.
 */

import { styleRef } from '../../../core/dom/style-refs';
import {
  ARMSRACE_STAGE_KEYS,
  ARMSRACE_STAGE_EVENTS,
  armsRaceStageLabel,
  armsRaceStageLetter,
  filterStageParticipants,
  sortArmsRaceParticipants,
  computeArmsRaceStats,
  fetchArmsRaceStatus,
  fetchArmsRaceMembers,
  fetchArmsRaceParticipants,
  fetchStageParticipants,
  populateStageParticipants,
  upsertStageStatus,
  fetchStageStartAt,
  updateStageParticipation,
  type ArmsRaceStageKey,
  type ArmsRaceStageState,
  type ArmsRaceParticipantRow,
} from '../armsrace.service';
import { pendingApprovalHtml, wirePendingApprovals } from '../../events/pending-approval';
import { EventsService } from '../../events/events.service';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild } from '../../../core/auth/roles';
import { buildEventSessionId } from '../../../core/config/events';
import { showToast } from '../../../core/dom/toast';
import { pickEventStart } from '../../../core/dom/ui';
import { t } from '../../../core/i18n/i18n';
import { notifyDiscordEvent } from '../../../core/integrations/discord';
import { formatDateTimeUTC, getWeekStart } from '../../../core/utils/date';
import { avatarInit, escapeHTML } from '../../../core/utils/text';
import { showConfirm } from '../../app/dialogs/dialogs.service';

// ── State ─────────────────────────────────────────────────────────────────────

interface ArmsRaceState {
  stages: { stageA: ArmsRaceStageState; stageB: ArmsRaceStageState };
  uidMap: Record<string, string>;
}

function createState(): ArmsRaceState {
  return {
    stages: {
      stageA: { active: false, sessionId: null, startAt: null, participants: [] },
      stageB: { active: false, sessionId: null, startAt: null, participants: [] },
    },
    uidMap: {},
  };
}

export class ArmsRaceView {
  private state: ArmsRaceState = createState();
  private activeStage: ArmsRaceStageKey = 'stageA';

  public getState(): ArmsRaceState {
    return this.state;
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  public async load(): Promise<void> {
    const db = getClient();
    if (!db) {
      this.render();
      return;
    }
    try {
      const currentG = getActiveGuild();
      if (!currentG) {
        // H2: this used to load ALPHA's Arms Race when resolution failed.
        this.render();
        return;
      }
      const statusQ: any = fetchArmsRaceStatus(db, currentG);
      const membersQ: any = fetchArmsRaceMembers(db, currentG);

      const [statusRes, membersRes] = await Promise.all([statusQ, membersQ]);

      ARMSRACE_STAGE_KEYS.forEach((k) => {
        const row = ((statusRes.data || []) as any[]).find((r) => r.event_name === ARMSRACE_STAGE_EVENTS[k]);
        this.state.stages[k].active = row ? !!row.is_active : false;
        this.state.stages[k].sessionId = row ? row.session_id : null;
        this.state.stages[k].startAt = row ? row.start_at : null;
      });

      this.state.uidMap = {};
      ((membersRes.data || []) as any[]).forEach((m) => {
        this.state.uidMap[m.pseudo] = m.uid;
      });

      const sids = ARMSRACE_STAGE_KEYS.map((k) => this.state.stages[k].sessionId).filter(Boolean) as string[];

      if (sids.length) {
        const partRes = await fetchArmsRaceParticipants(db, currentG, sids);
        const parts = (partRes.data || []) as ArmsRaceParticipantRow[];

        for (const k of ARMSRACE_STAGE_KEYS) {
          const evName = ARMSRACE_STAGE_EVENTS[k];
          const sid = this.state.stages[k].sessionId;
          this.state.stages[k].participants = filterStageParticipants(parts, evName, sid);

          // Auto-sync: active stage => trigger gm_populate_event_participants to
          // catch newly added/transferred members, then heal from the DB.
          if (this.state.stages[k].active && sid) {
            const week = getWeekStart(this.state.stages[k].startAt);
            try {
              await populateStageParticipants(db, k, sid, week, currentG);
            } catch (_) {
              /* best-effort */
            }
            const healRes = await fetchStageParticipants(db, currentG, evName, sid);
            this.state.stages[k].participants = (healRes.data || []) as ArmsRaceParticipantRow[];
          }
        }
      } else {
        this.state.stages.stageA.participants = [];
        this.state.stages.stageB.participants = [];
      }

      this.render();
    } catch (err) {
      console.error('loadArmsRace', err);
      this.render(); // render with whatever state we have so panel is never blank
    }
  }

  // ── Start / End / Edit / Delete ─────────────────────────────────────────────
  private async startStage(stageKey: ArmsRaceStageKey, startAt: string | null): Promise<void> {
    const db = getClient();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    const evName = ARMSRACE_STAGE_EVENTS[stageKey];
    const stageLetter = armsRaceStageLetter(stageKey);
    const currentG = getActiveGuild();
    if (!currentG) {
      // H2: starting a stage writes. Refuse rather than write into ALPHA.
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    let sessionId: string;
    if (stg && stg.active && stg.sessionId) {
      sessionId = stg.sessionId;
    } else {
      const taken = await EventsService.takenSessionIdsToday(currentG, evName, evName, startAt || null);
      if (!taken.ok) {
        // Unknown ids could mean a duplicate: refuse rather than merge sessions.
        showToast(t('toast_err_generic') + ' ' + taken.error, 'error');
        return;
      }
      sessionId = buildEventSessionId(evName, startAt || new Date(), taken.ids);
    }

    try {
      const res = await upsertStageStatus(db, {
        guild: currentG,
        event_name: evName,
        is_active: true,
        session_id: sessionId,
        start_at: startAt || null,
        stage: stageLetter,
        updated_at: new Date().toISOString(),
      });
      if (res.error) throw res.error;

      const week = getWeekStart(startAt);
      const rpcRes = await populateStageParticipants(db, stageKey, sessionId, week, currentG);
      if (rpcRes.error) throw rpcRes.error;

      showToast('Arms Race ' + armsRaceStageLabel(stageKey) + ' - ' + (t('event_started') || 'Started'), 'success');
      notifyDiscordEvent(evName, startAt || sessionId, 'start');
    } catch (err: any) {
      console.error('startStage', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
    await this.load();
  }

  private async endStage(stageKey: ArmsRaceStageKey): Promise<void> {
    const db = getClient();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    if (!stg.active) return;
    const currentG = getActiveGuild();

    try {
      await upsertStageStatus(db, {
        guild: currentG,
        event_name: ARMSRACE_STAGE_EVENTS[stageKey],
        is_active: false,
        session_id: stg.sessionId,
        start_at: null,
        stage: armsRaceStageLetter(stageKey),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('endStage', err);
    }

    showToast(t('event_session_ended'), 'success');
    await this.load();
  }

  private async editStageSchedule(stageKey: ArmsRaceStageKey): Promise<void> {
    const db = getClient();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    if (!stg || !stg.active || !stg.sessionId) return;

    try {
      const currentG = getActiveGuild();
      const res = await fetchStageStartAt(db, currentG, ARMSRACE_STAGE_EVENTS[stageKey]);
      if (res.error) throw res.error;

      const currentStartAt = res.data ? res.data.start_at : null;

      pickEventStart(
        {
          eventLabel: 'Arms Race ' + armsRaceStageLabel(stageKey) + ' - ' + t('edit_title'),
          defaultVal: currentStartAt,
        },
        async (startAt: string | null) => {
          if (!startAt) return;

          try {
            // One transaction (M4a): status and participants move together.
            // Recalculate session_id: pass [] to avoid collision check (renaming).
            const newSessionId = buildEventSessionId(ARMSRACE_STAGE_EVENTS[stageKey], new Date(startAt), []);
            const moved = await EventsService.rescheduleSession(
              ARMSRACE_STAGE_EVENTS[stageKey],
              stg.sessionId,
              newSessionId,
              startAt
            );
            stg.sessionId = moved.session_id;

            showToast(t('toast_member_updated'), 'success');
            notifyDiscordEvent(ARMSRACE_STAGE_EVENTS[stageKey], startAt, 'edit');

            await this.load();
          } catch (err: any) {
            console.error('editStageSchedule update', err);
            showToast(t('toast_err_generic') + ' ' + err.message, 'error');
          }
        }
      );
    } catch (err: any) {
      console.error('editStageSchedule fetch', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private deleteStageSession(stageKey: ArmsRaceStageKey): void {
    const db = getClient();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    if (!stg || !stg.sessionId) return;

    showConfirm(
      t('confirm_delete_session_title'),
      '<strong>Arms Race ' +
        escapeHTML(armsRaceStageLabel(stageKey)) +
        '</strong><br>' +
        t('confirm_delete_session_body'),
      async () => {
        try {
          // Participants and status, in one transaction (M4a).
          await EventsService.deleteSession(ARMSRACE_STAGE_EVENTS[stageKey], stg.sessionId);

          showToast(t('toast_session_deleted'), 'success');
          await this.load();
        } catch (err: any) {
          console.error('deleteStageSession', err);
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
      }
    );
  }

  private async saveParticipation(pseudo: string, value: number): Promise<void> {
    const db = getClient();
    if (!db) return;
    const stg = this.state.stages[this.activeStage];
    const currentG = getActiveGuild();
    await updateStageParticipation(db, currentG, ARMSRACE_STAGE_EVENTS[this.activeStage], stg.sessionId, pseudo, value);
  }

  // ── Dynamic member sync (memory only; DB writes happen upstream via RPC) ────
  public async addMemberToActiveEvents(pseudo: string): Promise<number> {
    const db = getClient();
    if (!db || !pseudo) return 0;
    try {
      const active = ARMSRACE_STAGE_KEYS.filter((k) => this.state.stages[k].active && this.state.stages[k].sessionId);
      if (active.length === 0) return 0;

      active.forEach((k) => {
        const stg = this.state.stages[k];
        if (stg.participants.some((p) => p.pseudo === pseudo)) return;
        stg.participants.push({
          event_name: ARMSRACE_STAGE_EVENTS[k],
          session_id: stg.sessionId,
          week_start: getWeekStart(stg.startAt || new Date(stg.sessionId as string)),
          pseudo: pseudo,
          participated: 0,
          score: null,
        });
        stg.participants = sortArmsRaceParticipants(stg.participants);
      });
      if (this.state.stages[this.activeStage].active) this.render();
      return active.length;
    } catch (err) {
      console.error('addMemberToActiveEvents AR', err);
      return 0;
    }
  }

  public removeMemberFromActiveEvents(pseudo: string): void {
    ARMSRACE_STAGE_KEYS.forEach((k) => {
      const stg = this.state.stages[k];
      if (stg.participants) {
        stg.participants = stg.participants.filter((p) => p.pseudo !== pseudo);
      }
    });
    if (this.state.stages[this.activeStage].active) this.render();
  }

  // ── Main render ────────────────────────────────────────────────────────────
  public render(): void {
    const area = document.querySelector('#event-arms-race .event-participants-area');
    if (!area) return;

    const stg = this.state.stages[this.activeStage];
    const stgLabel = armsRaceStageLabel(this.activeStage);
    const isActive = stg.active;

    const statusBadgeClass = isActive ? 'gm-chip-success active' : 'gm-chip-muted';
    const statusText = isActive ? t('event_active') : t('event_inactive');
    const dotColor = isActive ? 'var(--success)' : 'var(--fg-dim)';
    const subText = stg.startAt
      ? formatDateTimeUTC(stg.startAt)
      : isActive
        ? t('event_active')
        : t('event_not_active_hint');

    let html =
      '<div class="sf-main-tabs">' +
      '<button class="sf-main-tab stageA' +
      (this.activeStage === 'stageA' ? ' active' : '') +
      '" data-stage="stageA"><i class="ph ph-target"></i> Stage A</button>' +
      '<button class="sf-main-tab stageB' +
      (this.activeStage === 'stageB' ? ' active' : '') +
      '" data-stage="stageB"><i class="ph ph-target"></i> Stage B</button>' +
      '</div>';

    html +=
      '<div class="u-d-flex u-mb-1_5rem u-bg-card-bg u-border-1px-solid-card-border u-rounded-radius-lg u-p-1rem-1_5rem u-justify-space-between u-items-center u-wrap-wrap u-gap-1rem gm-event-banner">' +
      '<div class="u-d-flex u-items-center u-gap-1rem u-flex-1 u-minw-250px gm-event-meta">' +
      '<div class="gm-event-icon" data-gm-style="' +
      styleRef(
        'width: 48px; height: 48px; border-radius: 50%; background: ' +
          (isActive ? 'var(--primary-soft)' : 'rgba(255,255,255,0.05)') +
          '; color: ' +
          (isActive ? 'var(--primary)' : 'var(--text-muted)') +
          '; display: flex; align-items: center; justify-content: center; font-size: var(--fs-3xl);'
      ) +
      '"><i class="ph ph-target"></i></div>' +
      '<div class="u-d-flex u-dir-column u-gap-0_25rem gm-grow">' +
      '<div class="u-fs-fs-xl u-fw-700 u-ff-font-family-title gm-event-name">Arms Race ' +
      escapeHTML(stgLabel) +
      '</div>' +
      '<div class="u-d-flex u-items-center u-gap-0_5rem u-wrap-wrap gm-event-status-line">' +
      '<span class="u-d-inline-flex u-items-center u-gap-0_35rem u-fs-fs-sm event-status-badge gm-chip ' +
      statusBadgeClass +
      '"><span class="gm-dot" data-gm-style="' +
      styleRef('background: ' + dotColor + '; width: 8px; height: 8px; border-radius: 50%;') +
      '"></span> ' +
      statusText +
      '</span>' +
      '<span class="u-fs-fs-sm u-c-text-muted gm-dim">' +
      escapeHTML(subText) +
      '</span>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="u-d-flex u-gap-0_5rem gm-event-actions">' +
      (isActive
        ? '<button class="u-mr-0_25rem gm-btn gm-btn-danger event-end-btn ar-stage-end-btn" data-stage="' +
          this.activeStage +
          '"><i class="ph ph-stop-circle"></i> <span>' +
          t('event_end') +
          '</span></button>' +
          '<button class="u-bg-rgba-99-102-241-0_15 u-border-1px-solid-rgba-99-2a6e71 u-c-hexa5b4fc u-mr-0_25rem gm-btn ar-stage-edit-btn" data-stage="' +
          this.activeStage +
          '" title="' +
          t('edit_title') +
          '"><i class="ph ph-calendar"></i> <span>' +
          t('edit_title') +
          '</span></button>' +
          '<button class="u-bg-rgba-239-68-68-0_12 u-border-1px-solid-rgba-239-5b5d21 u-c-error gm-btn ar-stage-delete-btn" data-stage="' +
          this.activeStage +
          '" title="' +
          t('delete_title') +
          '"><i class="ph ph-trash"></i></button>'
        : '<button class="gm-btn gm-btn-success event-start-btn ar-stage-start-btn" data-stage="' +
          this.activeStage +
          '"><i class="ph ph-play"></i> <span>' +
          t('event_start') +
          '</span></button>' +
          '<button class="gm-btn gm-btn-danger event-end-btn ar-stage-end-btn" data-stage="' +
          this.activeStage +
          '" disabled><i class="ph ph-stop-circle"></i> <span>' +
          t('event_end') +
          '</span></button>') +
      '</div>' +
      '</div>';

    if (!isActive) {
      html +=
        '<div class="u-mt-2rem gm-empty">' +
        '<i class="ph ph-rocket-launch gm-icon"></i>' +
        '<div class="gm-empty-title">' +
        t('event_not_active') +
        '</div>' +
        '<div class="gm-empty-hint">' +
        t('event_not_active_hint') +
        '</div>' +
        '</div>';
      area.innerHTML = html;
      this.attachARListeners(area);
      return;
    }

    const participants = stg.participants;
    if (!participants.length) {
      html +=
        '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' +
        t('empty_members') +
        '</div></div>';
      area.innerHTML = html;
      this.attachARListeners(area);
      return;
    }

    const stats = computeArmsRaceStats(participants);

    html +=
      '<div class="u-gap-0_5rem u-mb-1rem u-wrap-wrap u-justify-space-between gm-row">' +
      '<div class="u-gap-0_5rem u-wrap-wrap gm-row event-stats">' +
      '<span class="gm-chip"><i class="ph ph-users"></i> ' +
      stats.total +
      ' ' +
      t('event_total') +
      '</span>' +
      '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> ' +
      stats.done +
      ' ' +
      t('event_participated') +
      '</span>' +
      '<span class="gm-chip"><i class="ph ph-x-circle"></i> ' +
      stats.absent +
      ' ' +
      t('event_absent') +
      '</span>' +
      '</div>' +
      '<div class="u-minw-220px u-maxw-320px gm-input-with-icon">' +
      '<i class="ph ph-magnifying-glass gm-icon"></i>' +
      '<input type="text" class="gm-input event-search-input" aria-label="' +
      escapeHTML(t('search_placeholder')) +
      '" placeholder="' +
      t('search_placeholder') +
      '">' +
      '<button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search" tabindex="-1"><i class="ph ph-x-circle"></i></button>' +
      '</div>' +
      '</div>' +
      '<div class="gm-table-wrap"><div class="gm-table-scroll">' +
      '<table class="gm-table gm-resp-table">' +
      '<thead><tr>' +
      '<th>' +
      t('col_member') +
      '</th>' +
      '<th class="gm-center">' +
      t('col_participated') +
      '</th>' +
      '</tr></thead><tbody>';

    participants.forEach((p) => {
      const isChecked = Number(p.participated) > 0;
      const initial = avatarInit(p.pseudo);
      html +=
        '<tr class="participant-row' +
        (isChecked ? ' participated' : '') +
        '" data-pseudo="' +
        escapeHTML(p.pseudo) +
        '">' +
        '<td data-label="' +
        t('col_member') +
        '">' +
        '<div class="u-gap-0_6rem gm-row">' +
        '<div class="gm-avatar">' +
        escapeHTML(initial) +
        '</div>' +
        '<strong>' +
        escapeHTML(p.pseudo) +
        '</strong>' +
        pendingApprovalHtml(p.pseudo, p.is_pending) +
        '</div>' +
        '</td>' +
        '<td class="gm-center" data-label="' +
        t('col_participated') +
        '">' +
        '<label class="check-toggle">' +
        '<input type="checkbox" class="participation-checkbox" data-pseudo="' +
        escapeHTML(p.pseudo) +
        '"' +
        (isChecked ? ' checked' : '') +
        '>' +
        '<span class="check-slider"></span>' +
        '</label>' +
        '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div></div>';
    area.innerHTML = html;
    this.attachARListeners(area);
  }

  private attachARListeners(area: Element): void {
    area.querySelectorAll('.sf-main-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeStage = (btn.getAttribute('data-stage') || 'stageA') as ArmsRaceStageKey;
        this.render();
      });
    });

    const startBtn = area.querySelector('.ar-stage-start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const stageKey = (startBtn.getAttribute('data-stage') || 'stageA') as ArmsRaceStageKey;
        pickEventStart({ eventLabel: 'Arms Race ' + armsRaceStageLabel(stageKey) }, (startAt: string | null) => {
          if (!startAt) return; // cancelled
          this.startStage(stageKey, startAt);
        });
      });
    }

    const endBtn = area.querySelector('.ar-stage-end-btn');
    if (endBtn) {
      endBtn.addEventListener('click', () => {
        const stageKey = (endBtn.getAttribute('data-stage') || 'stageA') as ArmsRaceStageKey;
        showConfirm(
          t('event_end'),
          '<strong>Arms Race ' + armsRaceStageLabel(stageKey) + '</strong><br>' + t('event_session_ended'),
          () => {
            this.endStage(stageKey);
          }
        );
      });
    }

    const editBtn = area.querySelector('.ar-stage-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const stageKey = (editBtn.getAttribute('data-stage') || 'stageA') as ArmsRaceStageKey;
        this.editStageSchedule(stageKey);
      });
    }

    const deleteBtn = area.querySelector('.ar-stage-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const stageKey = (deleteBtn.getAttribute('data-stage') || 'stageA') as ArmsRaceStageKey;
        this.deleteStageSession(stageKey);
      });
    }

    area.querySelectorAll('.participation-checkbox').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.addEventListener('change', () => {
        const next = cb.checked ? 1 : 0;
        const row = cb.closest('.participant-row');
        if (row) row.classList.toggle('participated', cb.checked);

        const pseudo = cb.getAttribute('data-pseudo') || '';
        this.saveParticipation(pseudo, next).then(() => {
          const pp = this.state.stages[this.activeStage].participants.find((p) => p.pseudo === pseudo);
          if (pp) pp.participated = next;
          this.refreshStats(area);
        });
      });
    });

    const stg = this.state.stages[this.activeStage];
    const db = getClient();
    const guild = getActiveGuild();
    if (db && guild && stg.sessionId) {
      wirePendingApprovals(
        area,
        {
          db,
          guild,
          eventName: ARMSRACE_STAGE_EVENTS[this.activeStage],
          sessionId: stg.sessionId,
          showToast,
        },
        (pseudo) => {
          const pp = stg.participants.find((p) => p.pseudo === pseudo);
          if (pp) pp.is_pending = false;
          this.render();
        }
      );
    }

    const searchInput = area.querySelector('.event-search-input') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.toLowerCase();
        area.querySelectorAll('.participant-row').forEach((row) => {
          const pseudo = (row.getAttribute('data-pseudo') || '').toLowerCase();
          const uid = (this.state.uidMap[row.getAttribute('data-pseudo') || ''] || '').toLowerCase();
          (row as HTMLElement).style.display = (pseudo + ' ' + uid).indexOf(q) !== -1 ? '' : 'none';
        });
      });
    }
  }

  private refreshStats(el: Element): void {
    const participants = this.state.stages[this.activeStage].participants;
    const stats = computeArmsRaceStats(participants);
    const chips = el.querySelectorAll('.event-stats .gm-chip');
    if (chips[1])
      chips[1].innerHTML = '<i class="ph ph-check-circle"></i> ' + stats.done + ' ' + t('event_participated');
    if (chips[2]) chips[2].innerHTML = '<i class="ph ph-x-circle"></i> ' + stats.absent + ' ' + t('event_absent');
  }
}

/** Shared singleton instance (bridged to `window.GM_ARMSRACE` at cutover). */
export const armsRaceView = new ArmsRaceView();

export default armsRaceView;
