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
 *   - All `window.GM.*` / `window.showConfirm` reads happen at call time through
 *     an internal typed adapter.
 *   - `load()` always renders, even on network error, so the panel is never
 *     left blank.
 *   - This module never assigns any `window.GM_*` variable.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  type ArmsRaceParticipantRow
} from '../armsrace.service';
import { escapeHTML } from '../../../core/utils/text';
import { pendingApprovalHtml, wirePendingApprovals } from '../../events/pending-approval';
import { EventsService } from '../../events/events.service';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

// ── Legacy adapter (call-time reads) ──────────────────────────────────────────

const legacy = {
  getDb(): any {
    const g = gm();
    return g && g.db ? g.db : null;
  },
  t(key: string): string {
    const g = gm();
    return g && typeof g.t === 'function' ? g.t(key) : key;
  },
  esc(value: unknown): string {
    return escapeHTML(value);
  },
  getActiveGuild(): string | null {
    const g = gm();
    return g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : null;
  },
  getWeekStart(dateArg?: unknown): string {
    const g = gm();
    if (!g || typeof g.getWeekStart !== 'function') return '';
    return dateArg === undefined ? g.getWeekStart() : g.getWeekStart(dateArg);
  },
  buildEventSessionId(eventName: string, when: unknown, existingIds?: unknown): string {
    const g = gm();
    if (!g || typeof g.buildEventSessionId !== 'function') return '';
    return g.buildEventSessionId(eventName, when, existingIds as any);
  },
  formatDateTimeUTC(value: unknown): string {
    const g = gm();
    return g && typeof g.formatDateTimeUTC === 'function' ? g.formatDateTimeUTC(value) : '';
  },
  avatarInit(value: unknown): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  notifyDiscordEvent(eventName: string, startAt: unknown, kind: string): void {
    const g = gm();
    if (g && typeof g.notifyDiscordEvent === 'function') g.notifyDiscordEvent(eventName, startAt, kind);
  },
  pickEventStart(opts: unknown, cb: (startAt: string | null) => void): void {
    const g = gm();
    if (g && typeof g.pickEventStart === 'function') g.pickEventStart(opts, cb);
  },
  showConfirm(title: string, body: string, onConfirm: () => void): void {
    const w = winAny();
    if (typeof w.showConfirm === 'function') w.showConfirm(title, body, onConfirm);
  }
};

// ── State ─────────────────────────────────────────────────────────────────────

interface ArmsRaceState {
  stages: { stageA: ArmsRaceStageState; stageB: ArmsRaceStageState };
  uidMap: Record<string, string>;
}

function createState(): ArmsRaceState {
  return {
    stages: {
      stageA: { active: false, sessionId: null, startAt: null, participants: [] },
      stageB: { active: false, sessionId: null, startAt: null, participants: [] }
    },
    uidMap: {}
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
    const db = legacy.getDb();
    if (!db) {
      this.render();
      return;
    }
    try {
      const currentG = legacy.getActiveGuild();
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
      ((membersRes.data || []) as any[]).forEach((m) => { this.state.uidMap[m.pseudo] = m.uid; });

      const sids = ARMSRACE_STAGE_KEYS
        .map((k) => this.state.stages[k].sessionId)
        .filter(Boolean) as string[];

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
            const week = legacy.getWeekStart(this.state.stages[k].startAt);
            try {
              await populateStageParticipants(db, k, sid, week, currentG);
            } catch (_) { /* best-effort */ }
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
    const db = legacy.getDb();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    const evName = ARMSRACE_STAGE_EVENTS[stageKey];
    const stageLetter = armsRaceStageLetter(stageKey);
    const currentG = legacy.getActiveGuild();
    if (!currentG) {
      // H2: starting a stage writes. Refuse rather than write into ALPHA.
      legacy.showToast(legacy.t('guild_unresolved'), 'error');
      return;
    }
    let sessionId: string;
    if (stg && stg.active && stg.sessionId) {
      sessionId = stg.sessionId;
    } else {
      const taken = await EventsService.takenSessionIdsToday(currentG, evName, evName, startAt || null);
      if (!taken.ok) {
        // Unknown ids could mean a duplicate: refuse rather than merge sessions.
        legacy.showToast(legacy.t('toast_err_generic') + ' ' + taken.error, 'error');
        return;
      }
      sessionId = legacy.buildEventSessionId(evName, startAt || new Date(), taken.ids);
    }

    try {
      const res = await upsertStageStatus(db,
        {
          guild: currentG,
          event_name: evName,
          is_active: true,
          session_id: sessionId,
          start_at: startAt || null,
          stage: stageLetter,
          updated_at: new Date().toISOString()
        }
      );
      if (res.error) throw res.error;

      const week = legacy.getWeekStart(startAt);
      const rpcRes = await populateStageParticipants(db, stageKey, sessionId, week, currentG);
      if (rpcRes.error) throw rpcRes.error;

      legacy.showToast('Arms Race ' + armsRaceStageLabel(stageKey) + ' - ' + (legacy.t('event_started') || 'Started'), 'success');
      legacy.notifyDiscordEvent(evName, startAt || sessionId, 'start');
    } catch (err: any) {
      console.error('startStage', err);
      legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
    }
    await this.load();
  }

  private async endStage(stageKey: ArmsRaceStageKey): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    if (!stg.active) return;
    const currentG = legacy.getActiveGuild();

    try {
      await upsertStageStatus(db,
        {
          guild: currentG,
          event_name: ARMSRACE_STAGE_EVENTS[stageKey],
          is_active: false,
          session_id: stg.sessionId,
          start_at: null,
          stage: armsRaceStageLetter(stageKey),
          updated_at: new Date().toISOString()
        }
      );
    } catch (err) { console.error('endStage', err); }

    legacy.showToast(legacy.t('event_session_ended'), 'success');
    await this.load();
  }

  private async editStageSchedule(stageKey: ArmsRaceStageKey): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    if (!stg || !stg.active || !stg.sessionId) return;

    try {
      const currentG = legacy.getActiveGuild();
      const res = await fetchStageStartAt(db, currentG, ARMSRACE_STAGE_EVENTS[stageKey]);
      if (res.error) throw res.error;

      const currentStartAt = res.data ? res.data.start_at : null;

      legacy.pickEventStart({
        eventLabel: 'Arms Race ' + armsRaceStageLabel(stageKey) + ' - ' + legacy.t('edit_title'),
        defaultVal: currentStartAt
      }, async (startAt: string | null) => {
        if (!startAt) return;

        try {
          // One transaction (M4a): status and participants move together.
          // Recalculate session_id: pass [] to avoid collision check (renaming).
          const newSessionId = legacy.buildEventSessionId(ARMSRACE_STAGE_EVENTS[stageKey], new Date(startAt), []);
          const moved = await EventsService.rescheduleSession(ARMSRACE_STAGE_EVENTS[stageKey], stg.sessionId, newSessionId, startAt);
          stg.sessionId = moved.session_id;

          legacy.showToast(legacy.t('toast_member_updated'), 'success');
          legacy.notifyDiscordEvent(ARMSRACE_STAGE_EVENTS[stageKey], startAt, 'edit');

          await this.load();
        } catch (err: any) {
          console.error('editStageSchedule update', err);
          legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
        }
      });
    } catch (err: any) {
      console.error('editStageSchedule fetch', err);
      legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private deleteStageSession(stageKey: ArmsRaceStageKey): void {
    const db = legacy.getDb();
    if (!db) return;
    const stg = this.state.stages[stageKey];
    if (!stg || !stg.sessionId) return;

    legacy.showConfirm(
      legacy.t('confirm_delete_session_title'),
      '<strong>Arms Race ' + legacy.esc(armsRaceStageLabel(stageKey)) + '</strong><br>' + legacy.t('confirm_delete_session_body'),
      async () => {
        try {
          // Participants and status, in one transaction (M4a).
          await EventsService.deleteSession(ARMSRACE_STAGE_EVENTS[stageKey], stg.sessionId);

          legacy.showToast(legacy.t('toast_session_deleted'), 'success');
          await this.load();
        } catch (err: any) {
          console.error('deleteStageSession', err);
          legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
        }
      }
    );
  }

  private async saveParticipation(pseudo: string, value: number): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const stg = this.state.stages[this.activeStage];
    const currentG = legacy.getActiveGuild();
    await updateStageParticipation(db, currentG, ARMSRACE_STAGE_EVENTS[this.activeStage], stg.sessionId, pseudo, value);
  }

  // ── Dynamic member sync (memory only; DB writes happen upstream via RPC) ────
  public async addMemberToActiveEvents(pseudo: string): Promise<number> {
    const db = legacy.getDb();
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
          week_start: legacy.getWeekStart(stg.startAt || new Date(stg.sessionId as string)),
          pseudo: pseudo,
          participated: 0,
          score: null
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
    const statusText = isActive ? legacy.t('event_active') : legacy.t('event_inactive');
    const dotColor = isActive ? 'var(--success)' : 'var(--fg-dim)';
    const subText = stg.startAt
      ? legacy.formatDateTimeUTC(stg.startAt)
      : (isActive ? legacy.t('event_active') : legacy.t('event_not_active_hint'));

    let html =
      '<div class="sf-main-tabs">' +
        '<button class="sf-main-tab stageA' + (this.activeStage === 'stageA' ? ' active' : '') + '" data-stage="stageA"><i class="ph ph-target"></i> Stage A</button>' +
        '<button class="sf-main-tab stageB' + (this.activeStage === 'stageB' ? ' active' : '') + '" data-stage="stageB"><i class="ph ph-target"></i> Stage B</button>' +
      '</div>';

    html +=
      '<div class="gm-event-banner" style="display: flex; margin-bottom: 1.5rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 1rem 1.5rem; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">' +
        '<div class="gm-event-meta" style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 250px;">' +
          '<div class="gm-event-icon" style="width: 48px; height: 48px; border-radius: 50%; background: ' + (isActive ? 'var(--primary-soft)' : 'rgba(255,255,255,0.05)') + '; color: ' + (isActive ? 'var(--primary)' : 'var(--text-muted)') + '; display: flex; align-items: center; justify-content: center; font-size: var(--fs-3xl);"><i class="ph ph-target"></i></div>' +
          '<div class="gm-grow" style="display: flex; flex-direction: column; gap: 0.25rem;">' +
            '<div class="gm-event-name" style="font-size: var(--fs-xl); font-weight: 700; font-family: var(--font-family-title);">Arms Race ' + legacy.esc(stgLabel) + '</div>' +
            '<div class="gm-event-status-line" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">' +
              '<span class="event-status-badge gm-chip ' + statusBadgeClass + '" style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: var(--fs-sm);"><span class="gm-dot" style="background: ' + dotColor + '; width: 8px; height: 8px; border-radius: 50%;"></span> ' + statusText + '</span>' +
              '<span class="gm-dim" style="font-size: var(--fs-sm); color: var(--text-muted);">' + legacy.esc(subText) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="gm-event-actions" style="display: flex; gap: 0.5rem;">' +
          (isActive ?
            '<button class="gm-btn gm-btn-danger event-end-btn ar-stage-end-btn" data-stage="' + this.activeStage + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + legacy.t('event_end') + '</span></button>' +
            '<button class="gm-btn ar-stage-edit-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-stage="' + this.activeStage + '" title="' + legacy.t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + legacy.t('edit_title') + '</span></button>' +
            '<button class="gm-btn ar-stage-delete-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-stage="' + this.activeStage + '" title="' + legacy.t('delete_title') + '"><i class="ph ph-trash"></i></button>'
          :
            '<button class="gm-btn gm-btn-success event-start-btn ar-stage-start-btn" data-stage="' + this.activeStage + '"><i class="ph ph-play"></i> <span>' + legacy.t('event_start') + '</span></button>' +
            '<button class="gm-btn gm-btn-danger event-end-btn ar-stage-end-btn" data-stage="' + this.activeStage + '" disabled><i class="ph ph-stop-circle"></i> <span>' + legacy.t('event_end') + '</span></button>'
          ) +
        '</div>' +
      '</div>';

    if (!isActive) {
      html +=
        '<div class="gm-empty" style="margin-top: 2rem;">' +
          '<i class="ph ph-rocket-launch gm-icon"></i>' +
          '<div class="gm-empty-title">' + legacy.t('event_not_active') + '</div>' +
          '<div class="gm-empty-hint">' + legacy.t('event_not_active_hint') + '</div>' +
        '</div>';
      area.innerHTML = html;
      this.attachARListeners(area);
      return;
    }

    const participants = stg.participants;
    if (!participants.length) {
      html += '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + legacy.t('empty_members') + '</div></div>';
      area.innerHTML = html;
      this.attachARListeners(area);
      return;
    }

    const stats = computeArmsRaceStats(participants);

    html +=
      '<div class="gm-row" style="gap:.5rem; margin-bottom:1rem; flex-wrap:wrap; justify-content:space-between;">' +
        '<div class="gm-row event-stats" style="gap:.5rem; flex-wrap:wrap;">' +
          '<span class="gm-chip"><i class="ph ph-users"></i> ' + stats.total + ' ' + legacy.t('event_total') + '</span>' +
          '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> ' + stats.done + ' ' + legacy.t('event_participated') + '</span>' +
          '<span class="gm-chip"><i class="ph ph-x-circle"></i> ' + stats.absent + ' ' + legacy.t('event_absent') + '</span>' +
        '</div>' +
        '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
          '<i class="ph ph-magnifying-glass gm-icon"></i>' +
          '<input type="text" class="gm-input event-search-input" placeholder="' + legacy.t('search_placeholder') + '">' +
          '<button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search" tabindex="-1"><i class="ph ph-x-circle"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="gm-table-wrap"><div class="gm-table-scroll">' +
      '<table class="gm-table gm-resp-table">' +
        '<thead><tr>' +
          '<th>' + legacy.t('col_member') + '</th>' +
          '<th class="gm-center">' + legacy.t('col_participated') + '</th>' +
        '</tr></thead><tbody>';

    participants.forEach((p) => {
      const isChecked = Number(p.participated) > 0;
      const initial = legacy.avatarInit(p.pseudo);
      html +=
        '<tr class="participant-row' + (isChecked ? ' participated' : '') + '" data-pseudo="' + legacy.esc(p.pseudo) + '">' +
          '<td data-label="' + legacy.t('col_member') + '">' +
            '<div class="gm-row" style="gap:.6rem;">' +
              '<div class="gm-avatar">' + legacy.esc(initial) + '</div>' +
              '<strong>' + legacy.esc(p.pseudo) + '</strong>' +
              pendingApprovalHtml(p.pseudo, p.is_pending) +
            '</div>' +
          '</td>' +
          '<td class="gm-center" data-label="' + legacy.t('col_participated') + '">' +
            '<label class="check-toggle">' +
              '<input type="checkbox" class="participation-checkbox" data-pseudo="' + legacy.esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
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
        legacy.pickEventStart({ eventLabel: 'Arms Race ' + armsRaceStageLabel(stageKey) }, (startAt: string | null) => {
          if (!startAt) return; // cancelled
          this.startStage(stageKey, startAt);
        });
      });
    }

    const endBtn = area.querySelector('.ar-stage-end-btn');
    if (endBtn) {
      endBtn.addEventListener('click', () => {
        const stageKey = (endBtn.getAttribute('data-stage') || 'stageA') as ArmsRaceStageKey;
        legacy.showConfirm(
          legacy.t('event_end'),
          '<strong>Arms Race ' + armsRaceStageLabel(stageKey) + '</strong><br>' + legacy.t('event_session_ended'),
          () => { this.endStage(stageKey); }
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
    const db = legacy.getDb();
    const guild = legacy.getActiveGuild();
    if (db && guild && stg.sessionId) {
      wirePendingApprovals(area, {
        db, guild, eventName: ARMSRACE_STAGE_EVENTS[this.activeStage], sessionId: stg.sessionId, showToast: legacy.showToast
      }, (pseudo) => {
        const pp = stg.participants.find((p) => p.pseudo === pseudo);
        if (pp) pp.is_pending = false;
        this.render();
      });
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
    if (chips[1]) chips[1].innerHTML = '<i class="ph ph-check-circle"></i> ' + stats.done + ' ' + legacy.t('event_participated');
    if (chips[2]) chips[2].innerHTML = '<i class="ph ph-x-circle"></i> ' + stats.absent + ' ' + legacy.t('event_absent');
  }
}

/** Shared singleton instance (bridged to `window.GM_ARMSRACE` at cutover). */
export const armsRaceView = new ArmsRaceView();

export default armsRaceView;
