/**
 * src/modules/shadowfront/views/ShadowfrontView.ts
 *
 * Strangler Phase 1 port of the legacy root `shadowfront.js` (1,388 lines) to a
 * strict-TypeScript view module. This file is NOT bridged onto
 * `window.GM_SHADOWFRONT` during Phase 1 (the legacy script still owns that
 * global until cutover): it is exercised by `tests/shadowfront_view.test.js`.
 *
 * Architecture:
 *   - Pure domain logic (constants, categorisation, history aggregation, squad
 *     sorting, Discord payload) lives in `shadowfront.service.ts`.
 *   - Shared helpers (i18n, toasts, dates, Discord, the Supabase client,
 *     dialogs) are typed imports; nothing is read from `window`.
 *   - `load()` always calls `render()`, even on fetch error, so the panel is
 *     never left blank.
 *   - This module never assigns any `window.GM_*` variable.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  SHADOWFRONT_EVENT_NAME,
  SHADOWFRONT_SQUAD_EVENT,
  SHADOWFRONT_PARTICIPANTS_MAX,
  SHADOWFRONT_RESERVES_MAX,
  SHADOWFRONT_COMMANDERS_MAX,
  categoriseHistory,
  categoryMeta,
  countRate,
  aggregateShadowfrontHistory,
  sortSquadList,
  formatSquadCompositionField,
  buildShadowfrontDiscordPayload,
  emptyShadowfrontHistory,
  type ShadowfrontAssignmentRow,
  type ShadowfrontParticipantRow,
  type ShadowfrontMemberRow,
  type ShadowfrontHistory,
  type ShadowfrontSquadKey,
  type ShadowfrontRole,
  type ShadowfrontCategory
} from '../shadowfront.service';
import * as ShadowfrontData from '../shadowfront.service';
import { pendingApprovalHtml, wirePendingApprovals } from '../../events/pending-approval';
import { EventsService } from '../../events/events.service';
import { fetchAllRows } from '../../../core/api/paginate';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild } from '../../../core/auth/roles';
import { buildEventSessionId, sessionDateFromId } from '../../../core/config/events';
import { getGuildConfig } from '../../../core/config/guild-config';
import { showToast } from '../../../core/dom/toast';
import { pickEventStart } from '../../../core/dom/ui';
import { t } from '../../../core/i18n/i18n';
import { formatDiscordRoleMention, notifyDiscordEvent, sendDiscordWebhookDetailed } from '../../../core/integrations/discord';
import { getPowerTier, getPowerTierMeta } from '../../../core/scoring/combat';
import { formatDateTimeUTC, getWeekStart } from '../../../core/utils/date';
import { escapeHTML, formatPower } from '../../../core/utils/text';
import { showConfirm } from '../../app/dialogs/dialogs.service';

// ── State ─────────────────────────────────────────────────────────────────────

interface SquadState {
  active: boolean;
  sessionId: string | null;
  startAt: string | null;
  ended?: boolean;
}

interface ShadowfrontState {
  squads: { squad1: SquadState; squad2: SquadState };
  allMembers: string[];
  membersData: ShadowfrontMemberRow[];
  assignments: ShadowfrontAssignmentRow[];
  participants: ShadowfrontParticipantRow[];
  history: Record<string, ShadowfrontHistory>;
  uidMap: Record<string, string>;
  signups: any[];
  maxPower: number;
}

function createState(): ShadowfrontState {
  return {
    squads: {
      squad1: { active: false, sessionId: null, startAt: null },
      squad2: { active: false, sessionId: null, startAt: null }
    },
    allMembers: [],
    membersData: [],
    assignments: [],
    participants: [],
    history: {},
    uidMap: {},
    signups: [],
    maxPower: 0
  };
}

export class ShadowfrontView {
  private state: ShadowfrontState = createState();
  private filter = 'all';
  private activeTab: 'composition' | 'tracking' = 'composition';
  private activeSquad: ShadowfrontSquadKey = 'squad1';
  private sort: 'rate' | 'power' = 'rate';

  public getState(): ShadowfrontState {
    return this.state;
  }

  public setStateForTest(state: Partial<ShadowfrontState>): void {
    this.state = Object.assign(this.state, state);
    this.render();
  }

  public getAssignments(): ShadowfrontAssignmentRow[] {
    return this.state.assignments || [];
  }

  public getActiveSquadSession(squadKey: ShadowfrontSquadKey): string | null {
    const sq = this.state.squads[squadKey];
    return sq ? sq.sessionId : null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private squadLabel(squad: ShadowfrontSquadKey): string {
    return squad === 'squad1' ? t('sf_squad1') : t('sf_squad2');
  }

  private getMemberPower(pseudo: string): number {
    const m = this.state.membersData.find((x) => x.pseudo === pseudo);
    return m ? (parseInt(String(m.overall_power), 10) || 0) : 0;
  }

  private categorise(pseudo: string): ShadowfrontCategory {
    return categoriseHistory(this.state.history[pseudo]);
  }

  private getParticipationBadgeHtml(pseudo: string): string {
    const h = this.state.history[pseudo] || { assigned: 0, participated: 0 };
    const rateText = h.assigned > 0 ? Math.round((h.participated / h.assigned) * 100) + '%' : 'N/A';
    const meta = categoryMeta(this.categorise(pseudo));
    return '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: var(--fs-xs); padding: 0.1rem 0.35rem; display: inline-flex; align-items: center; justify-content: center; min-width: 32px; border-radius: 4px; font-weight: 600;">' + rateText + '</span>';
  }

  private sortSquadListLocal(list: ShadowfrontAssignmentRow[]): ShadowfrontAssignmentRow[] {
    return sortSquadList(list, (pseudo) => this.getMemberPower(pseudo));
  }

  private activeSquadKeys(): ShadowfrontSquadKey[] {
    return (['squad1', 'squad2'] as ShadowfrontSquadKey[]).filter((k) => this.state.squads[k].active);
  }

  private anySquadActive(): boolean {
    return this.activeSquadKeys().length > 0;
  }

  private currentSessionIds(): string[] {
    return (['squad1', 'squad2'] as ShadowfrontSquadKey[])
      .map((k) => this.state.squads[k].sessionId)
      .filter(Boolean) as string[];
  }

  private activeSessionIds(): string[] {
    return (['squad1', 'squad2'] as ShadowfrontSquadKey[])
      .filter((k) => this.state.squads[k].active)
      .map((k) => this.state.squads[k].sessionId)
      .filter(Boolean) as string[];
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  public async load(): Promise<void> {
    const db = getClient();
    if (!db) {
      this.render();
      return;
    }
    try {
      const currentWeek = getWeekStart();
      const currentG = getActiveGuild();

      let statusQ: any = ShadowfrontData.fetchSquadStatuses(db);
      let membersQ: any = ShadowfrontData.fetchRosterMembers(db);
      // Whole-history reads: paged, since one answer stops at 1,000 rows.
      const squadsQ = fetchAllRows((from, to) => ShadowfrontData.fetchSquadHistoryPage(db, currentG, from, to));
      const partsQ = fetchAllRows((from, to) => ShadowfrontData.fetchParticipationHistoryPage(db, currentG, from, to));
      let signupsQ: any = ShadowfrontData.fetchWeekSignups(db, currentWeek);

      statusQ = statusQ.eq('guild', currentG);
      membersQ = membersQ.eq('guild', currentG);
      signupsQ = signupsQ.eq('guild', currentG);

      const [statusRes, membersRes, histSquads, histParts, signupRes] = await Promise.all([
        statusQ, membersQ, squadsQ, partsQ, signupsQ
      ]);
      // A partial history would show wrong totals with no sign of it.
      const loadError = statusRes.error || membersRes.error || histSquads.error || histParts.error || signupRes.error;
      if (loadError) throw loadError;

      const startedSessions: Record<string, boolean> = {};
      ((histParts.data || []) as ShadowfrontParticipantRow[]).forEach((r) => { if (r.session_id) startedSessions[r.session_id] = true; });

      (['squad1', 'squad2'] as ShadowfrontSquadKey[]).forEach((k) => {
        const row = ((statusRes.data || []) as any[]).find((r) => r.event_name === SHADOWFRONT_SQUAD_EVENT[k]);
        this.state.squads[k] = {
          active: row ? !!row.is_active : false,
          sessionId: row ? row.session_id : null,
          startAt: row ? row.start_at : null,
          // A squad is "ended" when inactive but keeps a session_id that
          // already has participants (launched then closed).
          ended: row ? (!row.is_active && row.session_id && !!startedSessions[row.session_id]) : false
        };
      });

      this.state.membersData = (membersRes.data || []) as ShadowfrontMemberRow[];
      this.state.allMembers = this.state.membersData.map((m) => m.pseudo);
      this.state.uidMap = {};
      this.state.membersData.forEach((m) => { this.state.uidMap[m.pseudo] = m.uid || ''; });
      this.state.signups = signupRes.data || [];

      const powers = this.state.membersData.map((m) => parseInt(String(m.overall_power), 10) || 0);
      this.state.maxPower = powers.length ? Math.max.apply(null, powers) : 0;

      const activeSids = this.activeSessionIds();
      const currentSids = this.currentSessionIds();

      this.state.history = aggregateShadowfrontHistory({
        histSquads: (histSquads.data || []) as Array<{ pseudo?: string; session_id?: string | null }>,
        histParts: (histParts.data || []) as ShadowfrontParticipantRow[],
        activeSessionIds: activeSids,
        startedSessions
      });

      if (currentSids.length) {
        const [assignRes, partRes] = await Promise.all([
          ShadowfrontData.fetchSquadAssignments(db, currentG, currentSids),
          ShadowfrontData.fetchSessionParticipants(db, currentG, currentSids)
        ]);
        this.state.assignments = (assignRes.data || []) as ShadowfrontAssignmentRow[];
        this.state.participants = (partRes.data || []) as ShadowfrontParticipantRow[];
      } else {
        this.state.assignments = [];
        this.state.participants = [];
      }

      this.render();
    } catch (err) {
      console.error('loadShadowfront', err);
      this.render(); // render with whatever state we have so panel is never blank
    }
  }

  // ── Start / End a squad ────────────────────────────────────────────────────
  private async startSquad(squad: ShadowfrontSquadKey, startAt: string | null): Promise<void> {
    const db = getClient();
    if (!db) return;
    const sq = this.state.squads[squad];
    const currentG = getActiveGuild();
    const oldSessionId = sq ? sq.sessionId : null;
    let sessionId: string;
    if (sq && sq.sessionId && !sq.ended) {
      sessionId = sq.sessionId;
    } else {
      if (!currentG) {
        showToast(t('guild_unresolved'), 'error');
        return;
      }
      const taken = await EventsService.takenSessionIdsToday(currentG, SHADOWFRONT_EVENT_NAME, SHADOWFRONT_SQUAD_EVENT[squad], startAt || null);
      if (!taken.ok) {
        // Unknown ids could mean a duplicate: refuse rather than merge sessions.
        showToast(t('toast_err_generic') + ' ' + taken.error, 'error');
        return;
      }
      sessionId = buildEventSessionId(SHADOWFRONT_SQUAD_EVENT[squad], startAt || new Date(), taken.ids);
    }
    if (sq) sq.ended = false;
    try {
      if (oldSessionId && oldSessionId !== sessionId) {
        await ShadowfrontData.moveSquadAssignmentsSession(db, currentG, oldSessionId, sessionId);
      }
      const res = await ShadowfrontData.upsertActiveSquadStatus(db, currentG, squad, sessionId, startAt);
      if (res.error) throw res.error;

      await this.syncParticipantRows(sessionId);

      showToast(this.squadLabel(squad) + ' - ' + t('sf_squad_started'), 'success');

      notifyDiscordEvent(SHADOWFRONT_SQUAD_EVENT[squad], startAt || sessionId, 'start');
    } catch (err: any) {
      console.error('startSquad', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
    await this.load();
  }

  private async endSquads(squads: ShadowfrontSquadKey[]): Promise<void> {
    const db = getClient();
    if (!db) return;
    const currentG = getActiveGuild();
    for (let i = 0; i < squads.length; i++) {
      const squad = squads[i];
      const currentSession = this.state.squads[squad] ? this.state.squads[squad].sessionId : null;
      try {
        await ShadowfrontData.upsertInactiveSquadStatus(db, currentG, squad, currentSession);
      } catch (err) { console.error('endSquad', err); }
    }
    showToast(t('sf_squad_ended'), 'success');
    await this.load();
  }

  private async editSquadSchedule(squad: ShadowfrontSquadKey): Promise<void> {
    const db = getClient();
    if (!db) return;
    const sq = this.state.squads[squad];
    if (!sq || !sq.active || !sq.sessionId) return;

    try {
      const currentG = getActiveGuild();
      const res = await ShadowfrontData.fetchSquadStartAt(db, currentG, squad);
      if (res.error) throw res.error;

      const currentStartAt = res.data ? res.data.start_at : null;

      pickEventStart({
        eventLabel: this.squadLabel(squad) + ' - ' + t('edit_title'),
        defaultVal: currentStartAt
      }, async (startAt) => {
        if (!startAt) return;

        try {
          // One transaction (M4a): status, squad rows and participants move to
          // the new start and session id together, or not at all. Four of the
          // six writes this replaces never checked their error.
          const newSessionId = buildEventSessionId(SHADOWFRONT_SQUAD_EVENT[squad], new Date(startAt), []);
          const moved = await EventsService.rescheduleSession(SHADOWFRONT_SQUAD_EVENT[squad], sq.sessionId, newSessionId, startAt);
          sq.sessionId = moved.session_id;

          showToast(t('toast_member_updated'), 'success');
          notifyDiscordEvent(SHADOWFRONT_SQUAD_EVENT[squad], startAt, 'edit');

          await this.load();
        } catch (err: any) {
          console.error('editSquadSchedule update', err);
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
      });
    } catch (err: any) {
      console.error('editSquadSchedule fetch', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private deleteSquadSession(squad: ShadowfrontSquadKey): void {
    const db = getClient();
    if (!db) return;
    const sq = this.state.squads[squad];
    if (!sq || !sq.sessionId) return;

    showConfirm(
      t('confirm_delete_session_title'),
      '<strong>' + escapeHTML(this.squadLabel(squad)) + '</strong><br>' + t('confirm_delete_session_body'),
      async () => {
        try {
          // Participants, squad rows and status, in one transaction (M4a).
          await EventsService.deleteSession(SHADOWFRONT_SQUAD_EVENT[squad], sq.sessionId);

          showToast(t('toast_session_deleted'), 'success');
          await this.load();
        } catch (err: any) {
          console.error('deleteSquadSession', err);
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
      }
    );
  }

  // ── Share composition on Discord ───────────────────────────────────────────
  private async shareCompositionOnDiscord(): Promise<void> {
    const db = getClient();
    if (!db) return;

    const squadKey: ShadowfrontSquadKey = this.activeSquad === 'squad2' ? 'squad2' : 'squad1';
    const sq = this.state.squads[squadKey];
    const sid = sq ? sq.sessionId : null;
    const members = this.state.assignments.filter((a) => {
      return a.squad === squadKey && (!sid || a.session_id === sid);
    });
    const squad = formatSquadCompositionField(members);

    const squadRoleKey = squadKey === 'squad2' ? 'discord_role_id_shadowfront_squad2' : 'discord_role_id_shadowfront_squad1';
    const roleId = await getGuildConfig(squadRoleKey) || await getGuildConfig('discord_role_id_shadowfront') || await getGuildConfig('discord_role_id');
    let roleMention = '';
    if (roleId) {
      roleMention = formatDiscordRoleMention(roleId);
    }

    const body = buildShadowfrontDiscordPayload({
      squadLabel: this.squadLabel(squadKey),
      squad,
      roleMention,
      participantsLabel: t('sf_participants'),
      reservesLabel: t('sf_reserves')
    });

    const res = await sendDiscordWebhookDetailed('shadowfront', body);
    if (res && res.ok) {
      showToast(t('sf_share_discord_sent'), 'success');
    } else {
      const errMsg = res && typeof res.error === 'object' ? JSON.stringify(res.error) : (res ? res.error : 'Unknown');
      showToast('Discord Error: ' + errMsg, 'error');
    }
  }

  // ── Assign / Unassign ──────────────────────────────────────────────────────
  private async assign(pseudo: string, squad: ShadowfrontSquadKey, role: ShadowfrontRole): Promise<void> {
    const db = getClient();
    if (!db) return;
    const sq = this.state.squads[squad];
    if (!sq) return;

    const currentG = getActiveGuild();

    if (!sq.sessionId || sq.ended) {
      sq.sessionId = buildEventSessionId(SHADOWFRONT_SQUAD_EVENT[squad], sq.startAt || new Date());
      sq.ended = false;
      try {
        await ShadowfrontData.upsertInactiveSquadStatus(db, currentG, squad, sq.sessionId);
      } catch (err) {
        console.error('auto create squad session error', err);
      }
    }

    const existing = this.state.assignments.filter((a) => a.squad === squad && a.role === role);
    const max = role === 'participant' ? SHADOWFRONT_PARTICIPANTS_MAX : SHADOWFRONT_RESERVES_MAX;
    if (existing.length >= max) { showToast(t('sf_squad_full'), 'error'); return; }

    const week = getWeekStart(sq.startAt || sessionDateFromId(sq.sessionId) || new Date());

    try {
      await ShadowfrontData.deleteWeekAssignment(db, currentG, week, pseudo);
    } catch (delErr) {
      console.warn('delete old assignment error', delErr);
    }

    const upsertRes = await ShadowfrontData.upsertSquadAssignment(db, currentG, week, sq.sessionId, pseudo, squad, role);

    if (upsertRes.error) {
      console.error('shadowfront_squads upsert error', upsertRes.error);
      showToast(t('toast_err_generic') + ' ' + upsertRes.error.message, 'error');
      return;
    }

    await this.syncParticipantRows(sq.sessionId);
    await this.load();
  }

  private async unassign(pseudo: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    const a = this.state.assignments.find((x) => x.pseudo === pseudo);
    if (!a) {
      const hasSignup = this.state.signups.some((s) => s.pseudo === pseudo);
      if (hasSignup) {
        const week = getWeekStart();
        const currentG = getActiveGuild();
        await ShadowfrontData.deleteSignup(db, currentG, week, pseudo);
      }
      return;
    }
    const g = (a && a.guild) || getActiveGuild();
    try {
      await ShadowfrontData.unsyncParticipant(db, g, a.session_id, pseudo);
    } catch (err) {
      console.warn('gm_unsync_shadowfront_participant RPC fallback:', err);
      await ShadowfrontData.deleteSessionAssignment(db, g, a.session_id, pseudo);
      await ShadowfrontData.deleteSessionParticipantRow(db, g, a.session_id, pseudo);
    }
    await this.load();
  }

  private async toggleCommander(pseudo: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    const assignment = this.state.assignments.find((a) => a.pseudo === pseudo);
    if (!assignment) return;

    const isNewCommander = !assignment.is_commander;
    const sq = this.state.squads[assignment.squad];
    if (!sq || !sq.sessionId) return;

    if (isNewCommander) {
      const currentCommanders = this.state.assignments.filter((a) => {
        return a.squad === assignment.squad && a.is_commander;
      });
      if (currentCommanders.length >= SHADOWFRONT_COMMANDERS_MAX) {
        showToast(t('sf_commanders_full', { n: SHADOWFRONT_COMMANDERS_MAX }), 'error');
        return;
      }
    }

    const currentG = getActiveGuild();
    await ShadowfrontData.updateCommander(db, currentG, sq.sessionId, pseudo, isNewCommander);

    await this.load();
  }

  // ── Sync participant rows ──────────────────────────────────────────────────
  private async syncParticipantRows(sessionId: string | null): Promise<void> {
    const db = getClient();
    if (!db || !sessionId) return;
    const currentG = getActiveGuild();
    try {
      const res = await ShadowfrontData.syncParticipants(db, currentG, sessionId);
      if (res.error) {
        console.error('syncParticipantRows RPC failed', res.error);
      }
    } catch (err) {
      console.error('syncParticipantRows RPC threw', err);
    }
  }

  private async saveParticipation(pseudo: string, value: number): Promise<void> {
    const db = getClient();
    if (!db) return;
    const p = this.state.participants.find((x) => x.pseudo === pseudo);
    if (!p) return;
    const g = p.guild || getActiveGuild();
    await ShadowfrontData.updateParticipated(db, g, p.session_id, pseudo, value);
  }

  private async saveLate(pseudo: string, value: boolean): Promise<void> {
    const db = getClient();
    if (!db) return;
    const p = this.state.participants.find((x) => x.pseudo === pseudo);
    if (!p) return;
    const g = p.guild || getActiveGuild();
    await ShadowfrontData.updateLate(db, g, p.session_id, pseudo, value);
  }

  private async saveExcused(pseudo: string, value: boolean): Promise<void> {
    const db = getClient();
    if (!db) return;
    const p = this.state.participants.find((x) => x.pseudo === pseudo);
    if (!p) return;
    const g = p.guild || getActiveGuild();
    await ShadowfrontData.updateExcused(db, g, p.session_id, pseudo, value);
  }

  private async saveSubPresent(pseudo: string, value: boolean): Promise<void> {
    const db = getClient();
    if (!db) return;
    const p = this.state.participants.find((x) => x.pseudo === pseudo);
    if (!p) return;
    const g = p.guild || getActiveGuild();
    await ShadowfrontData.updateSubPresent(db, g, p.session_id, pseudo, value);
  }

  // ── Main render ────────────────────────────────────────────────────────────
  public render(): void {
    const area = document.querySelector('#event-shadowfront .event-participants-area');
    if (!area) return;

    const sq = this.state.squads[this.activeSquad];
    const sqLabel = this.squadLabel(this.activeSquad);
    const isActive = sq.active;

    const statusBadgeClass = isActive ? 'gm-chip-success active' : 'gm-chip-muted';
    const statusText = isActive ? t('event_active') : t('event_inactive');
    const dotColor = isActive ? 'var(--success)' : 'var(--fg-dim)';
    const subText = sq.startAt
      ? formatDateTimeUTC(sq.startAt)
      : (isActive ? t('event_active') : t('sf_squad_inactive_hint'));

    let html =
      '<div class="sf-main-tabs">' +
        '<button class="sf-main-tab squad1' + (this.activeSquad === 'squad1' ? ' active' : '') + '" data-squad="squad1"><i class="ph ph-shield-star"></i> ' + t('sf_squad1') + '</button>' +
        '<button class="sf-main-tab squad2' + (this.activeSquad === 'squad2' ? ' active' : '') + '" data-squad="squad2"><i class="ph ph-shield-star"></i> ' + t('sf_squad2') + '</button>' +
      '</div>';

    html +=
      '<div class="gm-event-banner" style="display: flex; margin-bottom: 1.5rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: 1rem 1.5rem; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">' +
        '<div class="gm-event-meta" style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 250px;">' +
          '<div class="gm-event-icon" style="width: 48px; height: 48px; border-radius: 50%; background: ' + (isActive ? 'var(--primary-soft)' : 'rgba(255,255,255,0.05)') + '; color: ' + (isActive ? 'var(--primary)' : 'var(--text-muted)') + '; display: flex; align-items: center; justify-content: center; font-size: var(--fs-3xl);"><i class="ph ph-ghost"></i></div>' +
          '<div class="gm-grow" style="display: flex; flex-direction: column; gap: 0.25rem;">' +
            '<div class="gm-event-name" style="font-size: var(--fs-xl); font-weight: 700; font-family: var(--font-family-title);">' + escapeHTML(sqLabel) + '</div>' +
            '<div class="gm-event-status-line" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">' +
              '<span class="event-status-badge gm-chip ' + statusBadgeClass + '" style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: var(--fs-sm);"><span class="gm-dot" style="background: ' + dotColor + '; width: 8px; height: 8px; border-radius: 50%;"></span> ' + statusText + '</span>' +
              '<span class="gm-dim" style="font-size: var(--fs-sm); color: var(--text-muted);">' + escapeHTML(subText) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="gm-event-actions" style="display: flex; gap: 0.5rem;">' +
          (isActive ?
            '<button class="gm-btn gm-btn-danger event-end-btn sf-squad-end-btn" data-squad="' + this.activeSquad + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>' +
            '<button class="gm-btn sf-squad-edit-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-squad="' + this.activeSquad + '" title="' + t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + t('edit_title') + '</span></button>' +
            '<button class="gm-btn sf-squad-delete-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-squad="' + this.activeSquad + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button>'
          :
            '<button class="gm-btn gm-btn-success event-start-btn sf-squad-start-btn" data-squad="' + this.activeSquad + '"><i class="ph ph-play"></i> <span>' + t('event_start') + '</span></button>' +
            '<button class="gm-btn gm-btn-danger event-end-btn sf-squad-end-btn" data-squad="' + this.activeSquad + '" disabled><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>'
          ) +
        '</div>' +
      '</div>';

    if (sq.ended) {
      html +=
        '<div class="gm-empty" style="margin-top: 2rem;">' +
          '<i class="ph ph-ghost gm-icon"></i>' +
          '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
          '<div class="gm-empty-hint">' + t('sf_squad_inactive_hint') + '</div>' +
        '</div>';
      area.innerHTML = html;
      this.attachSFListeners(area);
      return;
    }

    const hasTrackableSession = this.currentSessionIds().length > 0;

    if (this.activeTab === 'tracking' && !hasTrackableSession) {
      this.activeTab = 'composition';
    }

    const stepBtn = (key: string, icon: string, label: string, enabled: boolean): string => {
      return '<button class="sf-step' + (this.activeTab === key ? ' active' : '') + (enabled ? '' : ' disabled') + '" data-tab="' + key + '"' + (enabled ? '' : ' disabled') + '>' +
        '<span class="sf-step-icon"><i class="ph ' + icon + '"></i></span>' +
        '<span class="sf-step-label">' + label + '</span>' +
        (enabled ? '' : '<span class="sf-step-lock"><i class="ph ph-lock-simple"></i></span>') +
      '</button>';
    };

    html +=
      '<div class="sf-stepper" style="margin-bottom: 1.5rem;">' +
        stepBtn('composition', 'ph-users-three', t('sf_step_composition'), true) +
        '<span class="sf-step-sep"></span>' +
        stepBtn('tracking', 'ph-chart-bar', t('sf_step_tracking'), hasTrackableSession) +
      '</div>';

    html +=
      '<div class="input-wrapper" style="margin-bottom: 1.5rem;">' +
        '<i class="ph ph-magnifying-glass"></i>' +
        '<input type="text" class="sf-search-input" placeholder="' + t('search_placeholder') + '">' +
      '</div>';

    // ── Panel: Composition ────────────────────────────────────────────────────
    if (this.activeTab === 'composition') {
      const assignedPseudos = this.state.assignments.map((a) => a.pseudo);

      const poolPseudos = this.state.allMembers.filter((pseudo) => {
        return assignedPseudos.indexOf(pseudo) === -1;
      });

      const confirmedParticipants = this.state.assignments.filter((a) => {
        return a.squad === this.activeSquad && a.role === 'participant';
      });
      const confirmedReserves = this.state.assignments.filter((a) => {
        return a.squad === this.activeSquad && a.role === 'reserve';
      });
      const squadParticipants = this.sortSquadListLocal(confirmedParticipants);
      const squadReserves = this.sortSquadListLocal(confirmedReserves);

      const rateOf = (pseudo: string): number => {
        const h = this.state.history[pseudo];
        return (h && h.assigned > 0) ? (h.participated / h.assigned) : 0;
      };

      let rateSum = 0, rateCount = 0;
      confirmedParticipants.forEach((a) => {
        if (this.state.history[a.pseudo] && this.state.history[a.pseudo].assigned > 0) {
          rateSum += rateOf(a.pseudo);
          rateCount++;
        }
      });
      const avgRate = rateCount > 0 ? Math.round((rateSum / rateCount) * 100) + '%' : 'N/A';

      html += '<div class="sf-sub-panel active">';
      html += '<div class="sf-compose-bar">' +
        '<div class="sf-compose-summary">' +
          '<span class="stat-chip"><i class="ph ph-users"></i> ' + t('sf_pool') + ': ' + poolPseudos.length + '</span>' +
          '<span class="stat-chip"><i class="ph ph-shield-check"></i> ' + t('sf_participants') + ': ' + confirmedParticipants.length + '/20</span>' +
          '<span class="stat-chip"><i class="ph ph-clock-countdown"></i> ' + t('sf_reserves') + ': ' + confirmedReserves.length + '/10</span>' +
          '<span class="stat-chip"><i class="ph ph-chart-line"></i> ' + t('sf_avg_rate') + ': ' + avgRate + '</span>' +
        '</div>' +
        '<div class="sf-compose-controls">' +
          '<div class="sf-sort-toggle" style="display:flex; gap:0.25rem;">' +
            '<button class="gm-btn gm-btn-xs sf-sort-btn' + (this.sort === 'rate' ? ' sf-sort-active' : '') + '" data-sort="rate" title="' + t('sf_sort_rate') + '"><i class="ph ph-chart-pie"></i> ' + t('sf_sort_rate') + '</button>' +
            '<button class="gm-btn gm-btn-xs sf-sort-btn' + (this.sort === 'power' ? ' sf-sort-active' : '') + '" data-sort="power" title="' + t('sf_sort_power') + '"><i class="ph ph-lightning"></i> ' + t('sf_sort_power') + '</button>' +
          '</div>' +
          '<button class="gm-btn sf-share-discord-btn" style="margin-left: auto;"><i class="ph ph-paper-plane-tilt"></i> ' + t('sf_share_discord') + '</button>' +
        '</div>' +
      '</div>';
      html += '<div class="sf-layout">';

      html +=
        '<div class="sf-column sf-unassigned">' +
        '<div class="sf-col-header"><i class="ph ph-users-three"></i> ' + t('sf_pool') +
          ' <span class="count-badge">' + poolPseudos.length + '</span></div>';

      html +=
        '<div class="sf-filter-tabs" style="padding: 0.5rem; justify-content: center; gap: 0.2rem;">' +
          '<button class="sf-filter-btn' + (this.filter === 'all' ? ' active' : '') + '" data-filter="all">' + t('sf_filter_all') + '</button>' +
          '<button class="sf-filter-btn' + (this.filter === 'excellent' ? ' active' : '') + '" data-filter="excellent">🟢 ' + t('sf_filter_excellent').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'excellent', (p) => this.state.history[p]) + '</span></button>' +
          '<button class="sf-filter-btn' + (this.filter === 'good' ? ' active' : '') + '" data-filter="good">🔵 ' + t('sf_filter_good').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'good', (p) => this.state.history[p]) + '</span></button>' +
          '<button class="sf-filter-btn' + (this.filter === 'average' ? ' active' : '') + '" data-filter="average">🟡 ' + t('sf_filter_average').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'average', (p) => this.state.history[p]) + '</span></button>' +
          '<button class="sf-filter-btn' + (this.filter === 'poor' ? ' active' : '') + '" data-filter="poor">🔴 ' + t('sf_filter_poor').split(' (')[0] + ' <span>' + countRate(poolPseudos, 'poor', (p) => this.state.history[p]) + '</span></button>' +
          '<button class="sf-filter-btn' + (this.filter === 'none' ? ' active' : '') + '" data-filter="none">⚫ ' + t('sf_filter_none').split(' /')[0] + ' <span>' + countRate(poolPseudos, 'none', (p) => this.state.history[p]) + '</span></button>' +
        '</div>';

      const sortedPool = poolPseudos.slice().sort((a, b) => {
        if (this.sort === 'power') return this.getMemberPower(b) - this.getMemberPower(a);
        const ra = rateOf(a), rb = rateOf(b);
        if (rb !== ra) return rb - ra;
        return this.getMemberPower(b) - this.getMemberPower(a);
      });
      const filteredPool = sortedPool.filter((p) => {
        return this.filter === 'all' ? true : this.categorise(p) === this.filter;
      });

      html += '<div class="sf-col-body" style="max-height: 480px; overflow-y: auto;">';
      if (filteredPool.length === 0) {
        html += '<div class="sf-empty">' + (poolPseudos.length === 0 ? t('sf_pool_empty') : t('sf_no_match_filter')) + '</div>';
      } else {
        filteredPool.forEach((pseudo) => {
          const cat = this.categorise(pseudo);
          const meta = categoryMeta(cat);
          const h = this.state.history[pseudo] || { assigned: 0, participated: 0, excused_count: 0 };
          const missed = h.assigned - h.participated;
          const rateText = h.assigned > 0
            ? Math.round((h.participated / h.assigned) * 100) + '%'
            : 'N/A';
          const stats = h.assigned > 0
            ? '<span class="sf-hist-stat">' + h.participated + '/' + h.assigned + '</span>'
            : '<span class="sf-hist-stat">-</span>';
          const tooltipText = h.assigned > 0
            ? h.participated + ' Play / ' + missed + ' Miss / ' + h.excused_count + ' Exc'
            : 'No history';

          const member = this.state.membersData.find((m) => m.pseudo === pseudo);
          const powerVal = member ? parseInt(String(member.overall_power), 10) || 0 : 0;
          const pTier = getPowerTier(powerVal, this.state.maxPower);
          const pMeta = getPowerTierMeta(pTier);
          const formattedPower = powerVal > 0 ? formatPower(powerVal) : '';

          const powerBadge = powerVal > 0
            ? '<span class="gm-chip" style="font-size: var(--fs-xs); padding:0.05rem 0.2rem; color:' + pMeta.color + '; border:1px solid ' + pMeta.color + '22; background:' + pMeta.color + '05; display:inline-flex; align-items:center; gap:0.15rem; margin-left:0.25rem;"><span style="font-size: var(--fs-sm);">' + pMeta.icon + '</span> ' + formattedPower + '</span>'
            : '';

          const btns =
            '<div class="sf-squad-btns">' +
              '<button class="sf-btn sf-btn-p" data-pseudo="' + escapeHTML(pseudo) + '" data-squad="' + this.activeSquad + '" data-role="participant" title="' + t('sf_participant') + '"><i class="ph ph-shield-check"></i></button>' +
              '<button class="sf-btn sf-btn-r" data-pseudo="' + escapeHTML(pseudo) + '" data-squad="' + this.activeSquad + '" data-role="reserve" title="' + t('sf_reserve') + '"><i class="ph ph-clock-countdown"></i></button>' +
            '</div>';

          html +=
            '<div class="sf-member-row sf-member-' + cat + '" style="border-left: 3px solid ' + (cat === 'excellent' ? 'var(--success)' : cat === 'good' ? '#60a5fa' : cat === 'average' ? '#fb923c' : cat === 'poor' ? 'var(--error)' : 'var(--text-muted)') + ';">' +
              '<div class="sf-member-info" style="display: flex; align-items: center; gap: 0.4rem; min-width: 0; overflow: hidden; flex: 1;">' +
                '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: var(--fs-xs); padding: 0.15rem 0.45rem;">' + rateText + '</span>' +
                '<span class="sf-pseudo" title="' + escapeHTML(tooltipText) + '" style="margin-left: 0.2rem; font-size: var(--fs-base); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + escapeHTML(pseudo) + '</span>' +
                powerBadge +
                stats +
              '</div>' +
              '<div class="sf-actions">' + btns + '</div>' +
            '</div>';
        });
      }
      html += '</div></div>'; // Column 1: Pool

      html += this.renderSquadColumn(this.activeSquad, squadParticipants, squadReserves);
      html += '</div>'; // sf-layout
      html += '</div>'; // active sub panel
    }

    // ── Panel: Tracking ────────────────────────────────────────────────────────
    else if (this.activeTab === 'tracking') {
      if (!sq || !sq.sessionId) {
        html +=
          '<div class="gm-empty" style="margin-top: 2rem;">' +
            '<i class="ph ph-rocket-launch gm-icon"></i>' +
            '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
            '<div class="gm-empty-hint">' + t('sf_squad_inactive_hint') + '</div>' +
          '</div>';
        area.innerHTML = html;
        this.attachSFListeners(area);
        return;
      }

      html += '<div class="sf-sub-panel active">';
      const activeSessionId = sq.sessionId;
      const squadTrackingParticipants = this.state.participants.filter((p) => p.session_id === activeSessionId);

      if (squadTrackingParticipants.length > 0) {
        html += this.renderTrackingTable(squadTrackingParticipants);
      } else {
        html += '<div class="empty-state">' + t('sf_no_one') + '</div>';
      }
      html += '</div>';
    }

    area.innerHTML = html;
    this.attachSFListeners(area);
  }

  private renderSquadColumn(squad: ShadowfrontSquadKey, participants: ShadowfrontAssignmentRow[], reserves: ShadowfrontAssignmentRow[]): string {
    const sq = this.state.squads[squad];
    const pFull = participants.length >= SHADOWFRONT_PARTICIPANTS_MAX;
    const rFull = reserves.length >= SHADOWFRONT_RESERVES_MAX;

    let html = '';

    html += '<div class="sf-column sf-squad-col' + (sq.active ? '' : ' sf-squad-off') + '">' +
      '<div class="sf-col-header squad-header ' + squad + '">' +
        '<i class="ph ph-shield-check"></i> ' + t('sf_participants') +
        ' <span class="sf-cap ' + (pFull ? 'full' : '') + '" style="margin-left: auto;">' + participants.length + '/' + SHADOWFRONT_PARTICIPANTS_MAX + '</span>' +
      '</div>' +
      '<div class="sf-col-body" style="max-height: 520px; overflow-y: auto;">';

    if (participants.length === 0) {
      html += '<div class="sf-empty">' + t('sf_no_one') + '</div>';
    } else {
      participants.forEach((a) => { html += this.renderAssignedRow(a.pseudo, true, !!a.is_commander); });
    }
    html += '</div></div>';

    html += '<div class="sf-column sf-squad-col' + (sq.active ? '' : ' sf-squad-off') + '">' +
      '<div class="sf-col-header squad-header ' + squad + '" style="filter: brightness(0.95);">' +
        '<i class="ph ph-clock-countdown"></i> ' + t('sf_reserves') +
        ' <span class="sf-cap ' + (rFull ? 'full' : '') + '" style="margin-left: auto;">' + reserves.length + '/' + SHADOWFRONT_RESERVES_MAX + '</span>' +
      '</div>' +
      '<div class="sf-col-body" style="max-height: 520px; overflow-y: auto;">';

    if (reserves.length === 0) {
      html += '<div class="sf-empty">' + t('sf_no_one') + '</div>';
    } else {
      reserves.forEach((a) => { html += this.renderAssignedRow(a.pseudo, false, !!a.is_commander); });
    }
    html += '</div></div>';

    return html;
  }

  private renderAssignedRow(pseudo: string, isParticipant: boolean, isCommander: boolean): string {
    const cat = this.categorise(pseudo);
    const meta = categoryMeta(cat);
    const h = this.state.history[pseudo] || { assigned: 0, participated: 0, excused_count: 0 };
    const missed = h.assigned - h.participated;
    const rateText = h.assigned > 0
      ? Math.round((h.participated / h.assigned) * 100) + '%'
      : 'N/A';
    const stats = h.assigned > 0
      ? '<span class="sf-hist-stat">' + h.participated + '/' + h.assigned + '</span>'
      : '<span class="sf-hist-stat">-</span>';
    const tooltipText = h.assigned > 0
      ? h.participated + ' Played / ' + missed + ' Missed / ' + h.excused_count + ' Excused'
      : 'No previous matches';

    let cmdBtn = '';
    if (isParticipant) {
      const iconClass = isCommander ? 'ph ph-star' : 'ph ph-star';
      const starColor = isCommander ? 'color: #eab308; cursor: pointer;' : 'color: var(--fg-dim); cursor: pointer;';
      cmdBtn = '<button class="sf-commander-btn" data-pseudo="' + escapeHTML(pseudo) + '" title="Toggle Commander" style="background: none; border: none; padding: 0.2rem; margin-right: 0.25rem;' + starColor + '">' +
        '<i class="' + iconClass + '" style="font-size: var(--fs-xl);"></i>' +
      '</button>';
    }

    const member = this.state.membersData.find((m) => m.pseudo === pseudo);
    const powerVal = member ? parseInt(String(member.overall_power), 10) || 0 : 0;
    const pTier = getPowerTier(powerVal, this.state.maxPower);
    const pMeta = getPowerTierMeta(pTier);
    const formattedPower = powerVal > 0 ? formatPower(powerVal) : '';
    const powerBadge = powerVal > 0
      ? '<span class="gm-chip" style="font-size: var(--fs-xs); padding:0.05rem 0.2rem; color:' + pMeta.color + '; border:1px solid ' + pMeta.color + '22; background:' + pMeta.color + '05; display:inline-flex; align-items:center; gap:0.15rem; margin-right: 0.25rem;"><span style="font-size: var(--fs-sm);">' + pMeta.icon + '</span> ' + formattedPower + '</span>'
      : '';

    const rowStyle = 'display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.6rem; border-radius: 6px; background: rgba(0,0,0,0.15); border: 1px solid transparent; gap: 0.4rem; font-size: var(--fs-base);';

    return '<div class="sf-assigned-row" style="' + rowStyle + '">' +
      '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: var(--fs-xs); padding: 0.1rem 0.35rem; margin-right: 0.25rem;">' + rateText + '</span>' +
      '<span class="sf-pseudo" title="' + escapeHTML(tooltipText) + '" style="font-weight: 500; font-size: var(--fs-base); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 0.25rem;">' +
        escapeHTML(pseudo) +
      '</span>' +
      powerBadge +
      stats +
      '<div style="display: flex; align-items: center; gap: 0.2rem;">' +
        cmdBtn +
        '<button class="sf-remove-btn" data-pseudo="' + escapeHTML(pseudo) + '" title="' + t('sf_remove') + '"><i class="ph ph-x"></i></button>' +
      '</div>' +
    '</div>';
  }

  private renderTrackingTable(participants: ShadowfrontParticipantRow[]): string {
    const done = participants.reduce((s, p) => s + (Number(p.participated) || 0), 0);

    let html =
      '<div class="sf-tracking">' +
        '<div class="sf-tracking-header"><i class="ph ph-chart-bar"></i> ' + t('sf_tracking_title') + '</div>' +
        '<div class="event-stats" style="margin-bottom: 1rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;">' +
          '<span class="stat-chip"><i class="ph ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
          '<span class="stat-chip success"><i class="ph ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
          '<button type="button" class="gm-btn gm-btn-sm sf-all-present-btn" style="font-size: var(--fs-sm); padding: 0.25rem 0.5rem;"><i class="ph ph-check-square"></i> ' + t('sf_all_present') + '</button>' +
          '<button type="button" class="gm-btn gm-btn-sm sf-all-absent-btn" style="font-size: var(--fs-sm); padding: 0.25rem 0.5rem;"><i class="ph ph-square"></i> ' + t('sf_all_absent') + '</button>' +
          '<span class="sf-saved-flash" style="opacity:0; transition: opacity 0.3s; font-size: var(--fs-sm); color:var(--success);"></span>' +
        '</div>' +
        '<div class="participants-table-wrap"><table class="participants-table"><thead><tr>' +
          '<th>' + t('col_member') + '</th>' +
          '<th>' + t('sf_squad_col') + '</th>' +
          '<th class="center">' + t('col_participated') + '</th>' +
          '<th class="center">Late</th>' +
          '<th class="center">Excused</th>' +
          '<th class="center">Sub Present</th>' +
          '<th style="width: 60px; text-align: right;">Actions</th>' +
        '</tr></thead><tbody>';

    participants.forEach((p) => {
      const assignment = this.state.assignments.find((a) => a.pseudo === p.pseudo);
      const squadLbl = assignment
        ? this.squadLabel(assignment.squad) + ' - ' + (assignment.role === 'participant' ? t('sf_participant') : t('sf_reserve'))
        : '-';
      const isChecked = Number(p.participated) > 0;
      const isLateChecked = !!p.late;
      const isExcusedChecked = !!p.excused;
      const isSubPresentChecked = !!p.sub_present;

      const cat = this.categorise(p.pseudo || '');
      const meta = categoryMeta(cat);
      const h = this.state.history[p.pseudo || ''] || { assigned: 0, participated: 0 };
      const rateText = h.assigned > 0
        ? Math.round((h.participated / h.assigned) * 100) + '%'
        : 'N/A';

      const rowClass = 'participant-row' + (isChecked ? ' participated' : '');

      html +=
        '<tr class="' + rowClass + '">' +
          '<td class="pseudo-cell" style="display: flex; align-items: center; gap: 0.5rem;">' +
            '<span class="sf-rate-badge ' + meta.cls + '" style="font-size: var(--fs-xs); padding: 0.1rem 0.35rem;">' + rateText + '</span>' +
            '<strong style="font-size: var(--fs-base);">' + escapeHTML(p.pseudo) + '</strong>' +
            pendingApprovalHtml(p.pseudo, p.is_pending) +
          '</td>' +
          '<td><span class="squad-chip ' + (assignment ? assignment.squad : '') + '">' + squadLbl + '</span></td>' +
          '<td class="check-cell">' +
            '<label class="check-toggle">' +
              '<input type="checkbox" class="participation-checkbox sf-participation-checkbox" data-pseudo="' + escapeHTML(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
              '<span class="check-slider"></span>' +
            '</label>' +
          '</td>' +
          '<td class="check-cell">' +
            '<label class="check-toggle check-toggle-warning">' +
              '<input type="checkbox" class="sf-late-checkbox" data-pseudo="' + escapeHTML(p.pseudo) + '"' + (isLateChecked ? ' checked' : '') + '>' +
              '<span class="check-slider"></span>' +
            '</label>' +
          '</td>' +
          '<td class="check-cell">' +
            '<label class="check-toggle check-toggle-info">' +
              '<input type="checkbox" class="sf-excused-checkbox" data-pseudo="' + escapeHTML(p.pseudo) + '"' + (isExcusedChecked ? ' checked' : '') + '>' +
              '<span class="check-slider"></span>' +
            '</label>' +
          '</td>' +
          '<td class="check-cell">' +
            '<label class="check-toggle check-toggle-accent">' +
              '<input type="checkbox" class="sf-sub-present-checkbox" data-pseudo="' + escapeHTML(p.pseudo) + '"' + (isSubPresentChecked ? ' checked' : '') + '>' +
              '<span class="check-slider"></span>' +
            '</label>' +
          '</td>' +
          '<td style="white-space: nowrap; text-align: right;"><button class="delete-btn sf-delete-participant-btn" data-pseudo="' + escapeHTML(p.pseudo) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button></td>' +
        '</tr>';
    });

    html += '</tbody></table></div></div>';
    return html;
  }

  private async bulkSetParticipation(value: number): Promise<void> {
    const db = getClient();
    if (!db) return;
    const sq = this.state.squads[this.activeSquad];
    if (!sq || !sq.sessionId) return;
    try {
      const currentG = getActiveGuild();
      await ShadowfrontData.updateSessionParticipated(db, currentG, sq.sessionId, value);
      this.state.participants.forEach((p) => {
        if (p.session_id === sq.sessionId) p.participated = value;
      });
      this.render();
      this.flashSaved();
    } catch (err: any) {
      console.error('bulkSetParticipation failed', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private flashSaved(): void {
    const el = document.querySelector('#event-shadowfront .sf-saved-flash');
    if (!el) return;
    (el as HTMLElement).textContent = t('sf_saved');
    (el as HTMLElement).style.opacity = '1';
    setTimeout(() => { (el as HTMLElement).style.opacity = '0'; }, 1500);
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  private attachSFListeners(area: Element): void {
    area.querySelectorAll('.sf-main-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeSquad = (btn.getAttribute('data-squad') || 'squad1') as ShadowfrontSquadKey;
        this.render();
      });
    });

    const startBtn = area.querySelector('.sf-squad-start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const squad = (startBtn.getAttribute('data-squad') || 'squad1') as ShadowfrontSquadKey;
        pickEventStart({ eventLabel: 'Shadowfront - ' + this.squadLabel(squad) }, (startAt: string | null) => {
          if (!startAt) return; // cancelled
          this.startSquad(squad, startAt);
        });
      });
    }

    const endBtn = area.querySelector('.sf-squad-end-btn');
    if (endBtn) {
      endBtn.addEventListener('click', () => {
        const squad = (endBtn.getAttribute('data-squad') || 'squad1') as ShadowfrontSquadKey;
        showConfirm(
          t('event_end'),
          '<strong>' + this.squadLabel(squad) + '</strong><br>' + t('sf_squad_ended'),
          () => {
            this.endSquads([squad]);
          }
        );
      });
    }

    const editBtn = area.querySelector('.sf-squad-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const squad = (editBtn.getAttribute('data-squad') || 'squad1') as ShadowfrontSquadKey;
        this.editSquadSchedule(squad);
      });
    }

    const deleteBtn = area.querySelector('.sf-squad-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const squad = (deleteBtn.getAttribute('data-squad') || 'squad1') as ShadowfrontSquadKey;
        this.deleteSquadSession(squad);
      });
    }

    area.querySelectorAll('.sf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.assign(
          btn.getAttribute('data-pseudo') || '',
          (btn.getAttribute('data-squad') || 'squad1') as ShadowfrontSquadKey,
          (btn.getAttribute('data-role') || 'participant') as ShadowfrontRole
        );
      });
    });
    area.querySelectorAll('.sf-remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => { this.unassign(btn.getAttribute('data-pseudo') || ''); });
    });
    area.querySelectorAll('.sf-commander-btn').forEach((btn) => {
      btn.addEventListener('click', () => { this.toggleCommander(btn.getAttribute('data-pseudo') || ''); });
    });

    area.querySelectorAll('.sf-sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.sort = (btn.getAttribute('data-sort') || 'rate') as 'rate' | 'power';
        this.render();
      });
    });

    const allPresentBtn = area.querySelector('.sf-all-present-btn');
    if (allPresentBtn) {
      allPresentBtn.addEventListener('click', () => { this.bulkSetParticipation(1); });
    }
    const allAbsentBtn = area.querySelector('.sf-all-absent-btn');
    if (allAbsentBtn) {
      allAbsentBtn.addEventListener('click', () => { this.bulkSetParticipation(0); });
    }

    const refreshStats = (): void => {
      const done = this.state.participants.filter((p) => Number(p.participated) > 0).length;
      const chip = area.querySelector('.event-stats .stat-chip.success');
      if (chip) {
        chip.innerHTML = '<i class="ph ph-check-circle"></i> ' + done + ' ' + t('event_participated');
      }
    };

    const sfSession = this.state.squads[this.activeSquad] ? this.state.squads[this.activeSquad].sessionId : null;
    const sfDb = getClient();
    const sfGuild = getActiveGuild();
    if (sfDb && sfGuild && sfSession) {
      wirePendingApprovals(area, {
        db: sfDb, guild: sfGuild, eventName: SHADOWFRONT_EVENT_NAME, sessionId: sfSession, showToast
      }, (pseudo) => {
        const pp = this.state.participants.find((p) => p.pseudo === pseudo && p.session_id === sfSession);
        if (pp) pp.is_pending = false;
        this.render();
      });
    }

    area.querySelectorAll('.sf-participation-checkbox').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.addEventListener('change', () => {
        const next = cb.checked ? 1 : 0;
        const row = cb.closest('.participant-row');
        if (row) row.classList.toggle('participated', cb.checked);

        const pseudo = cb.getAttribute('data-pseudo') || '';
        const pp = this.state.participants.find((p) => p.pseudo === pseudo);
        if (pp) pp.participated = next;
        refreshStats();

        this.saveParticipation(pseudo, next).then(() => this.flashSaved());
      });
    });
    area.querySelectorAll('.sf-late-checkbox').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.addEventListener('change', () => {
        const pseudo = cb.getAttribute('data-pseudo') || '';
        this.saveLate(pseudo, cb.checked).then(() => {
          const pp = this.state.participants.find((p) => p.pseudo === pseudo);
          if (pp) pp.late = cb.checked;
          this.flashSaved();
        });
      });
    });
    area.querySelectorAll('.sf-excused-checkbox').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.addEventListener('change', () => {
        const pseudo = cb.getAttribute('data-pseudo') || '';
        this.saveExcused(pseudo, cb.checked).then(() => {
          const pp = this.state.participants.find((p) => p.pseudo === pseudo);
          if (pp) pp.excused = cb.checked;
          this.flashSaved();
        });
      });
    });
    area.querySelectorAll('.sf-sub-present-checkbox').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.addEventListener('change', () => {
        const pseudo = cb.getAttribute('data-pseudo') || '';
        this.saveSubPresent(pseudo, cb.checked).then(() => {
          const pp = this.state.participants.find((p) => p.pseudo === pseudo);
          if (pp) pp.sub_present = cb.checked;
          this.flashSaved();
        });
      });
    });
    area.querySelectorAll('.sf-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filter = btn.getAttribute('data-filter') || 'all';
        this.render();
      });
    });

    area.querySelectorAll('.sf-delete-participant-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pseudo = btn.getAttribute('data-pseudo') || '';
        showConfirm(
          t('delete_title'),
          '<strong>' + escapeHTML(pseudo) + '</strong><br>' + t('confirm_remove_participant_body'),
          async () => {
            const db = getClient();
            if (!db) return;
            const p = this.state.participants.find((x) => x.pseudo === pseudo);
            if (!p) return;
            const g = p.guild || getActiveGuild();
            await ShadowfrontData.deleteParticipant(db, g, p.session_id, pseudo);
            this.load();
          }
        );
      });
    });

    const shareBtn = area.querySelector('.sf-share-discord-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => { this.shareCompositionOnDiscord(); });
    }

    area.querySelectorAll('.sf-step').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn.getAttribute('data-tab') || 'composition') as 'composition' | 'tracking';
        this.render();
      });
    });

    const searchInput = area.querySelector('.sf-search-input') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.toLowerCase();
        area.querySelectorAll('.sf-member-row, .sf-assigned-row, .sf-entry-row').forEach((row) => {
          const btn = row.querySelector('.sf-btn, .sf-remove-btn');
          const pseudo = btn ? (btn.getAttribute('data-pseudo') || '') : '';
          const uid = this.state.uidMap[pseudo] || '';
          const match = (pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1;
          (row as HTMLElement).style.display = match ? 'flex' : 'none';
        });
        area.querySelectorAll('.participant-row').forEach((row) => {
          const cb = row.querySelector('.sf-participation-checkbox');
          const pseudo = cb ? (cb.getAttribute('data-pseudo') || '') : '';
          const uid = this.state.uidMap[pseudo] || '';
          const match = (pseudo.toLowerCase() + ' ' + uid.toLowerCase()).indexOf(q) !== -1;
          (row as HTMLElement).style.display = match ? '' : 'none';
        });
      });
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_SHADOWFRONT` at cutover). */
export const shadowfrontView = new ShadowfrontView();

export default shadowfrontView;
