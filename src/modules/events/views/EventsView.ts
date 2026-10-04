/**
 * src/modules/events/views/EventsView.ts
 *
 * Strangler Phase 1 port of the root `events.js` (SvS / GvG / Defend Trade
 * Route session tracking). Preserves the per-tab in-memory state, the
 * `.event-participants-area` rendering, the SECURITY DEFINER approval RPC, and
 * the batched "Approve All" via `GM.runInChunks(pendingPseudos, 10, ...)`.
 *
 * This module never assigns `window.GM_EVENTS` (bridge added at cutover).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  TAB_TO_DB_EVENTS,
  PANEL_MAP,
  EVENTS_WITHOUT_SCORE,
  SCHEDULED_TABS,
  type EventTabKey,
  type EventTabState,
  EventsService,
  fetchTabEventStatus,
  upsertEventStatus,
  populateEventParticipants,
  fetchActiveEventStatuses,
  fetchEventSessionParticipants,
  fetchGuildMemberUids,
  setParticipantParticipation,
  setParticipantAppointed,
  updateParticipantScore,
  fetchEventStartAt,
  approveParticipantSubmission,
  type WarEventName,
  type OpponentCandidate
} from '../events.service';
import type { WarSession, ChestTier } from '../../../types/database';
import { resolveChestsForScore, resolvePrepChests, prepTotal, aggregateTierSlice, defaultChestGrid, WAR_AGGREGATE_DAY, PREP_DAYS } from '../../../core/scoring/chests';
import { renderBadge, renderWarStatusBadge } from '../../../components/ui/Badge';
import { formatCompactNumber, formatNumber } from '../../../core/utils/numbers';
import { openDialog } from '../../../components/ui/Dialog';
import { getGuildConfig, setGuildConfig } from '../../../core/config/guild-config';
import { paintEventCoeffLabels } from '../../../core/config/event-coeff-labels';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild } from '../../../core/auth/roles';
import { buildEventSessionId } from '../../../core/config/events';
import { showToast } from '../../../core/dom/toast';
import { attachNumberFormatter, pickEventStart } from '../../../core/dom/ui';
import { t } from '../../../core/i18n/i18n';
import { notifyDiscordEvent } from '../../../core/integrations/discord';
import { runInChunks } from '../../../core/utils/async';
import { formatDateTimeUTC, getWeekStart } from '../../../core/utils/date';
import { avatarInit, escapeHTML, parseNumber } from '../../../core/utils/text';
import { showConfirm } from '../../app/dialogs/dialogs.service';

interface WarDayScore {
  day: number;
  score: number;
  chests_unlocked: number;
}

/** Prep score entry mode of a war tab (grid layout + input conventions). */
type WarScoreMode = 'detailed' | 'aggregate';

interface WarTabState {
  session: WarSession | null;
  opponents: OpponentCandidate[];
  grid: ChestTier[];
  daily: Record<string, WarDayScore[]>;
  mode: WarScoreMode;
}

function createTabState(): EventTabState {
  return { activeEventName: null, sessionId: null, stage: null, startAt: null, isActive: false, participants: [] };
}

export class EventsView {
  private state: Record<string, EventTabState> = {};
  private uidMap: Record<string, string> = {};
  private guildOverride: string | null = null;
  private war: Record<string, WarTabState> = {};
  private warSaveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  constructor() {
    Object.keys(TAB_TO_DB_EVENTS).forEach((k) => { this.state[k] = createTabState(); });
  }

  public getState(): Record<string, EventTabState> {
    return this.state;
  }

  private currentGuild(): string | null {
    return this.guildOverride || getActiveGuild();
  }

  // ── Load event (called when a tab is clicked) ─────────────────────────────
  public async loadEvent(tabKey: string, customGuildId?: string): Promise<void> {
    if (customGuildId) this.guildOverride = customGuildId;
    const db = getClient();
    if (!db || !TAB_TO_DB_EVENTS[tabKey]) return;
    void paintEventCoeffLabels();
    try {
      const dbEvents = TAB_TO_DB_EVENTS[tabKey];
      const currentG = this.currentGuild();
      const query: any = fetchTabEventStatus(db, currentG, dbEvents);
      const res = await query;

      const active = ((res.data || []) as any[]).find((r) => r.is_active);
      const s = this.state[tabKey];
      if (active) {
        s.activeEventName = active.event_name;
        s.sessionId = active.session_id;
        s.stage = active.stage;
        s.startAt = active.start_at;
        s.isActive = true;
        this.renderStatus(tabKey);
        await this.fetchParticipants(tabKey);
        // Self-heal: session active but no participants ⇒ repopulate.
        if (s.sessionId && s.participants.length === 0) {
          await this.populateParticipants(tabKey);
        }
        await this.loadWarMeta(tabKey);
      } else {
        s.activeEventName = null;
        s.sessionId = null;
        s.stage = null;
        s.startAt = null;
        s.isActive = false;
        this.resetWar(tabKey);
        this.renderStatus(tabKey);
        this.renderInactive(tabKey);
      }
    } catch (err) { console.error('loadEvent', err); }
  }

  // ── Start a new session ───────────────────────────────────────────────────
  private async startEvent(tabKey: string, dbEventName: string, stage: string | null, startAt?: string | null): Promise<void> {
    const db = getClient();
    if (!db) return;
    const currentG = this.currentGuild();
    const ref = startAt || new Date();
    if (!currentG) {
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    // Today's taken session ids, to resolve same-day collisions.
    const taken = await EventsService.takenSessionIdsToday(currentG, dbEventName, dbEventName, ref);
    if (!taken.ok) {
      // Unknown ids could mean a duplicate: refuse rather than merge sessions.
      showToast(t('toast_err_generic') + ' ' + taken.error, 'error');
      return;
    }
    const sessionId = buildEventSessionId(dbEventName, ref, taken.ids);
    try {
      const statusRes = await upsertEventStatus(db,
        {
          guild: currentG,
          event_name: dbEventName,
          is_active: true,
          session_id: sessionId,
          stage: stage || null,
          start_at: startAt || null,
          updated_at: new Date().toISOString()
        }
      );
      if (statusRes.error) throw statusRes.error;
      showToast(t('event_session_started'), 'success');
      notifyDiscordEvent(dbEventName, startAt || sessionId, 'start');
    } catch (err: any) {
      console.error('startEvent', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
    await this.loadEvent(tabKey);
  }

  // ── End current session ───────────────────────────────────────────────────
  private async endEvent(tabKey: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName) return;
    const currentG = this.currentGuild();
    try {
      const statusRes = await upsertEventStatus(db,
        {
          guild: currentG,
          event_name: s.activeEventName,
          is_active: false,
          session_id: s.sessionId,
          stage: s.stage,
          updated_at: new Date().toISOString()
        }
      );
      if (statusRes.error) throw statusRes.error;
      s.activeEventName = null;
      s.sessionId = null;
      s.stage = null;
      s.isActive = false;
      this.renderStatus(tabKey);
      this.renderInactive(tabKey);
      showToast(t('event_session_ended'), 'success');
    } catch (err: any) {
      console.error('endEvent', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  // ── Auto-populate members for a new session (SECURITY DEFINER RPC) ────────
  private async populateParticipants(tabKey: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    const week = getWeekStart(s.startAt);
    const currentG = this.currentGuild();
    const rpcRes = await populateEventParticipants(db, s.activeEventName, s.sessionId, week, currentG);

    if (rpcRes.error) {
      console.error('populateParticipants: rpc error', rpcRes.error);
      showToast(t('toast_err_import_participants') + ' ' + rpcRes.error.message, 'error');
      return;
    }

    const inserted = (typeof rpcRes.data === 'number') ? rpcRes.data : 0;
    if (inserted > 0) showToast(inserted + ' ' + t('toast_members_imported'), 'success');
    await this.fetchParticipants(tabKey);
  }

  // ── In-memory sync of a newly added member ────────────────────────────────
  public async addMemberToActiveEvents(pseudo: string): Promise<number> {
    const db = getClient();
    if (!db || !pseudo) return 0;

    const dbEventNames: string[] = [];
    Object.keys(TAB_TO_DB_EVENTS).forEach((k) => { TAB_TO_DB_EVENTS[k].forEach((n) => dbEventNames.push(n)); });

    try {
      const currentG = this.currentGuild();
      const statusRes = await fetchActiveEventStatuses(db, currentG, dbEventNames);
      if (statusRes.error) throw statusRes.error;

      const active = ((statusRes.data || []) as any[]).filter((r) => r.session_id);
      if (active.length === 0) return 0;

      Object.keys(this.state).forEach((tabKey) => {
        const s = this.state[tabKey];
        if (!s.isActive || !s.sessionId) return;
        const matched = active.find((a) => a.event_name === s.activeEventName && a.session_id === s.sessionId);
        if (!matched) return;
        if (s.participants.some((p) => p.pseudo === pseudo)) return;
        s.participants.push({
          event_name: s.activeEventName,
          session_id: s.sessionId,
          week_start: getWeekStart(matched.start_at || new Date()),
          pseudo,
          participated: 0,
          score: null
        });
        s.participants.sort((a, b) => String(a.pseudo).localeCompare(String(b.pseudo)));
        this.renderParticipants(tabKey);
      });

      return active.length;
    } catch (err) {
      console.error('addMemberToActiveEvents', err);
      return 0;
    }
  }

  public removeMemberFromActiveEvents(pseudo: string): void {
    Object.keys(this.state).forEach((tabKey) => {
      const s = this.state[tabKey];
      if (s.participants) {
        s.participants = s.participants.filter((p) => p.pseudo !== pseudo);
        if (s.isActive) {
          this.renderStatus(tabKey);
          this.renderParticipants(tabKey);
        }
      }
    });
  }

  // ── Fetch participants of the active session ──────────────────────────────
  private async fetchParticipants(tabKey: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    const currentG = this.currentGuild();
    const week = getWeekStart(s.startAt);

    // Auto-sync missing/transferred guild members before fetching.
    try {
      await populateEventParticipants(db, s.activeEventName, s.sessionId, week, currentG);
    } catch (_) { /* best-effort sync */ }

    const [partRes, memRes] = await Promise.all([
      fetchEventSessionParticipants(db, currentG, s.activeEventName, s.sessionId),
      fetchGuildMemberUids(db, currentG)
    ]);
    if (partRes.error) return;
    ((memRes.data || []) as any[]).forEach((m) => { this.uidMap[m.pseudo] = m.uid; });
    s.participants = (partRes.data || []) as any[];
    this.renderParticipants(tabKey);
  }

  // ── SvS / GvG granular war helpers (opponent, W/L, per-day grid) ─────────

  private isWarTab(tabKey: string): boolean {
    const ev = this.state[tabKey] && this.state[tabKey].activeEventName;
    return ev === 'SvS' || ev === 'GvG';
  }

  private getWar(tabKey: string): WarTabState {
    if (!this.war[tabKey]) {
      this.war[tabKey] = { session: null, opponents: [], grid: defaultChestGrid(tabKey), daily: {}, mode: 'detailed' };
    }
    return this.war[tabKey];
  }

  private isGranular(tabKey: string): boolean {
    const s = this.state[tabKey];
    if (!s.isActive || !s.activeEventName || !s.sessionId) return false;
    if (!this.isWarTab(tabKey)) return false;
    return !!this.war[tabKey];
  }

  private async loadWarMeta(tabKey: string): Promise<void> {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    if (!this.isWarTab(tabKey)) return;

    const host = this.getPanel(tabKey)?.querySelector<HTMLElement>('.war-banner');
    if (!host) return;
    const guild = this.currentGuild();
    // H2: reading war meta without a resolved tenant used to read ALPHA's.
    if (!guild) return;
    const ev = s.activeEventName as WarEventName;
    const war = this.getWar(tabKey);

    // Prep entry mode is a guild preference per event (guild_config), shared
    // with the History modal — aggregates read the same daily-scores source.
    try {
      const savedMode = await getGuildConfig('war_prep_mode:' + ev);
      war.mode = savedMode === 'aggregate' ? 'aggregate' : 'detailed';
    } catch (_) {
      war.mode = 'detailed';
    }

    const sessRes = await EventsService.getWarSession(guild, ev, s.sessionId);
    if (sessRes.ok) war.session = sessRes.session ?? null;
    else war.session = null;

    const snapshot = war.session
      && Array.isArray(war.session.chest_tiers_snapshot)
      && (war.session.chest_tiers_snapshot as unknown as unknown[]).length > 0
      ? (war.session.chest_tiers_snapshot as unknown as ChestTier[])
      : null;
    if (snapshot) {
      war.grid = snapshot;
    } else {
      const tierRes = await EventsService.getChestTiers(guild, ev);
      war.grid = tierRes.ok && tierRes.tiers.length > 0 ? tierRes.tiers : defaultChestGrid(ev);
    }

    if (!war.session) war.session = await this.ensureWarSession(tabKey);

    const [candRes, dailyRes] = await Promise.all([
      EventsService.listOpponentCandidates(guild, ev === 'SvS' ? 'server' : 'guild'),
      EventsService.getDailyScores(guild, ev, s.sessionId)
    ]);
    war.opponents = candRes.ok ? candRes.items : [];
    war.daily = {};
    if (dailyRes.ok) {
      for (const row of dailyRes.rows) {
        const arr = war.daily[row.pseudo] || [];
        arr.push({ day: row.day, score: row.score ?? 0, chests_unlocked: row.chests_unlocked ?? 0 });
        war.daily[row.pseudo] = arr;
      }
    }

    this.renderWarBanner(tabKey);
    this.renderParticipants(tabKey);
  }

  private async ensureWarSession(tabKey: string): Promise<WarSession | null> {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return null;
    const guild = this.currentGuild();
    // H2: creating a war session writes. No tenant, no session.
    if (!guild) return null;
    const res = await EventsService.upsertWarSession({
      guild,
      eventName: s.activeEventName as WarEventName,
      sessionId: s.sessionId
    });
    return res.ok && res.session ? res.session : null;
  }

  private resetWar(tabKey: string): void {
    delete this.war[tabKey];
    const host = this.getPanel(tabKey)?.querySelector<HTMLElement>('.war-banner');
    if (host) host.innerHTML = '';
  }

  private warTotalScore(tabKey: string): number {
    const war = this.war[tabKey];
    if (!war) return 0;
    return Object.values(war.daily).reduce((sum, list) => {
      const byDay: Record<number, number> = {};
      let pvp = 0;
      for (const entry of list) {
        if (entry.day === 6) pvp = Number(entry.score) || 0;
        else byDay[entry.day] = Number(entry.score) || 0;
      }
      const prep = prepTotal(Object.keys(byDay).map((d) => ({ day: Number(d), score: byDay[Number(d)] })));
      return sum + prep + pvp;
    }, 0);
  }

  private warMode(tabKey: string): WarScoreMode {
    return this.getWar(tabKey).mode === 'aggregate' ? 'aggregate' : 'detailed';
  }

  private renderWarBanner(tabKey: string): void {
    const panel = this.getPanel(tabKey);
    const host = panel ? panel.querySelector<HTMLElement>('.war-banner') : null;
    if (!host) return;
    const s = this.state[tabKey];
    const war = this.getWar(tabKey);
    const isSvs = s.activeEventName === 'SvS';
    const datalistId = 'war-opponents-' + tabKey;

    const anySession = war.session
      && (war.session as any).opponent_snapshot
      && typeof (war.session as any).opponent_snapshot === 'object';
    const current = anySession ? String(((war.session as any).opponent_snapshot.name) || '') : '';

    const dayChips = [1, 2, 3, 4, 5, 6].map((d) => {
      const result: 'won' | 'lost' | null = war.session ? (war.session as any)['day' + d + '_result'] || null : null;
      const statusBadge = renderWarStatusBadge(
        result === 'won' ? 'W' : result === 'lost' ? 'L' : 'neutral',
        { won: t('war_day_won'), lost: t('war_day_lost'), pending: t('war_day_pending') }
      );
      const cls = result === 'won' ? 'war-day-won' : result === 'lost' ? 'war-day-lost' : 'war-day-neutral';
      const tooltip = this.warDayTooltip(d, result);
      return '<button type="button" class="war-day-toggle ' + cls + '" data-day="' + d + '" data-result="' + (result || 'neutral') + '" title="' + escapeHTML(tooltip) + '" aria-label="' + escapeHTML(tooltip) + '">' +
        '<span class="war-day-num">D' + d + '</span>' +
        '<span class="war-day-state">' + statusBadge + '</span>' +
      '</button>';
    }).join('');

    const options = war.opponents.map((o) =>
      '<option value="' + escapeHTML(o.name) + '"></option>'
    ).join('');

    const mode = this.warMode(tabKey);
    const modeSwitch =
      '<div class="gm-row war-mode-switch" role="group" aria-label="' + escapeHTML(t('war_mode_detailed')) + '/' + escapeHTML(t('war_mode_aggregate')) + '" style="gap:.5rem; flex-wrap:wrap; align-items:center; justify-content:flex-end;">' +
        '<span class="gm-chip" style="white-space:nowrap;">' + t('war_day_total_prep') + '</span>' +
        '<button type="button" class="war-mode-btn gm-btn gm-btn-sm' + (mode === 'detailed' ? ' gm-active' : '') + '" data-war-mode="detailed" style="padding:0.3rem 0.6rem;"><i class="ph ph-list-numbers"></i> ' + escapeHTML(t('war_mode_detailed')) + '</button>' +
        '<button type="button" class="war-mode-btn gm-btn gm-btn-sm' + (mode === 'aggregate' ? ' gm-active' : '') + '" data-war-mode="aggregate" style="padding:0.3rem 0.6rem;"><i class="ph ph-plus-minus"></i> ' + escapeHTML(t('war_mode_aggregate')) + '</button>' +
      '</div>';

    host.innerHTML =
      '<div class="gm-card gm-card-padded" style="margin-bottom:1rem;">' +
        '<div class="gm-row" style="gap:1rem; flex-wrap:wrap; align-items:center; justify-content:space-between;">' +
          '<div class="gm-row" style="gap:.5rem; align-items:center; flex:1 1 260px; min-width:220px;">' +
            '<span class="gm-chip" style="white-space:nowrap;">' + t('war_opponent_label') + '</span>' +
            '<input type="text" class="gm-input war-opponent-input" list="' + datalistId + '" placeholder="' +
              escapeHTML(isSvs ? t('war_opponent_placeholder_svs') : t('war_opponent_placeholder_gvg')) + '" value="' + escapeHTML(current) + '">' +
            '<datalist id="' + datalistId + '">' + options + '</datalist>' +
          '</div>' +
          '<div class="gm-row war-day-results" style="gap:.45rem; flex-wrap:wrap;" data-event="' + escapeHTML(s.activeEventName || '') + '">' + dayChips + '</div>' +
        '</div>' +
        '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; align-items:center; justify-content:space-between; margin-top:.6rem;">' +
          '<span class="gm-dim" style="font-size:var(--fs-2xs);">' + escapeHTML(t(mode === 'aggregate' ? 'war_col_total_d15' : 'war_ocr_granular_hint')) + '</span>' +
          modeSwitch +
        '</div>' +
      '</div>';

    const input = host.querySelector<HTMLInputElement>('.war-opponent-input');
    if (input) {
      input.addEventListener('change', () => { void this.saveWarOpponent(tabKey, input.value); });
    }
    host.querySelectorAll('.war-day-toggle').forEach((btn) => {
      btn.addEventListener('click', () => { this.cycleWarDay(tabKey, btn as HTMLElement); });
    });
    host.querySelectorAll('.war-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setWarMode(tabKey, btn.getAttribute('data-war-mode') === 'aggregate' ? 'aggregate' : 'detailed');
      });
    });
  }

  private setWarMode(tabKey: string, mode: WarScoreMode): void {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    const war = this.getWar(tabKey);
    if (war.mode === mode) return;
    war.mode = mode;
    void setGuildConfig('war_prep_mode:' + s.activeEventName, mode);
    this.renderWarBanner(tabKey);
    this.renderParticipants(tabKey);
  }

  private async saveWarOpponent(tabKey: string, rawValue: string): Promise<void> {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    const name = String(rawValue || '').trim();
    if (!name) return;
    const isSvs = s.activeEventName === 'SvS';
    const war = this.getWar(tabKey);
    const known = war.opponents.find((o) => o && String(o.name).toLowerCase() === name.toLowerCase());
    const guild = this.currentGuild();
    if (!guild) {
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    const res = await EventsService.upsertWarSession({
      guild,
      eventName: s.activeEventName as WarEventName,
      sessionId: s.sessionId,
      opponent: {
        kind: isSvs ? 'server' : 'guild',
        name,
        server_number: known && known.server_number ? known.server_number : undefined,
        guild_ref: known && (known as any).guild_ref ? (known as any).guild_ref : undefined
      }
    });
    if (res.ok) {
      if (res.session) war.session = res.session;
      this.renderWarBanner(tabKey);
    } else {
      showToast(t('war_opponent_save_error'), 'error');
      this.renderWarBanner(tabKey);
    }
  }

  private warDayTooltip(day: number, result: 'won' | 'lost' | null): string {
    const dayLabel = 'Day ' + day;
    if (result === 'won') return dayLabel + ' : Won (Click: Lost)';
    if (result === 'lost') return dayLabel + ' : Lost (Click: Neutral)';
    return dayLabel + ' : Neutral (Click: Won)';
  }

  private cycleWarDay(tabKey: string, btn: HTMLElement): void {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    const day = Number(btn.getAttribute('data-day'));
    if (!(day >= 1 && day <= 6)) return;
    const guild = this.currentGuild();
    // H2: guard BEFORE the optimistic UI update, so the button cannot show a
    // result that was never persisted (and never persisted into ALPHA).
    if (!guild) {
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    const war = this.getWar(tabKey);
    const key = 'day' + day + '_result';
    const prev: 'won' | 'lost' | null = war.session ? (war.session as any)[key] || null : null;
    const next: 'won' | 'lost' | null = prev === 'won' ? 'lost' : prev === 'lost' ? null : 'won';

    if (!war.session) {
      war.session = {
        guild: this.currentGuild(),
        event_name: s.activeEventName as WarEventName,
        session_id: s.sessionId,
        day1_result: null, day2_result: null, day3_result: null,
        day4_result: null, day5_result: null, day6_result: null,
        opponent_snapshot: null,
        chest_tiers_snapshot: []
      } as any;
    }
    (war.session as any)[key] = next;

    btn.classList.remove('war-day-won', 'war-day-lost', 'war-day-neutral');
    if (next === 'won') btn.classList.add('war-day-won');
    else if (next === 'lost') btn.classList.add('war-day-lost');
    else btn.classList.add('war-day-neutral');

    btn.setAttribute('data-result', next || 'neutral');
    const tooltip = this.warDayTooltip(day, next);
    btn.setAttribute('title', tooltip);
    btn.setAttribute('aria-label', tooltip);

    const stateSpan = btn.querySelector('.war-day-state');
    if (stateSpan) {
      stateSpan.innerHTML = renderWarStatusBadge(
        next === 'won' ? 'W' : next === 'lost' ? 'L' : 'neutral',
        { won: t('war_day_won'), lost: t('war_day_lost'), pending: t('war_day_pending') }
      );
    }

    void EventsService.upsertWarSession({
      guild,
      eventName: s.activeEventName as WarEventName,
      sessionId: s.sessionId,
      dailyResults: { ['day' + day]: next }
    }).then((res) => {
      if (res.ok && res.session) {
        war.session = { ...war.session, ...res.session, [key]: next };
      } else {
        showToast(t('war_opponent_save_error') || 'Failed to save day result', 'error');
        this.renderWarBanner(tabKey);
      }
    });
  }

  private wireGranularInputs(el: Element, tabKey: string): void {
    el.querySelectorAll('.day-score-input').forEach((node) => {
      const inp = node as HTMLInputElement;
      attachNumberFormatter(inp);
      const pseudo = inp.getAttribute('data-pseudo') || '';
      const triggerSave = (): void => {
        const row = inp.closest('.participant-row');
        if (row) this.updateChestCell(row, tabKey);
        const timerKey = tabKey + '::' + pseudo;
        if (this.warSaveTimers[timerKey]) {
          clearTimeout(this.warSaveTimers[timerKey]);
          delete this.warSaveTimers[timerKey];
        }
        void this.saveGranularRow(tabKey, pseudo, row);
      };
      inp.addEventListener('input', () => {
        const row = inp.closest('.participant-row');
        if (row) this.updateChestCell(row, tabKey);
        const timerKey = tabKey + '::' + pseudo;
        if (this.warSaveTimers[timerKey]) clearTimeout(this.warSaveTimers[timerKey]);
        this.warSaveTimers[timerKey] = setTimeout(() => {
          void this.saveGranularRow(tabKey, pseudo, row);
        }, 700);
      });
      inp.addEventListener('change', () => {
        triggerSave();
      });
    });
  }

  private updateChestCell(row: Element | null, tabKey: string): void {
    if (!row) return;
    const grid = this.getWar(tabKey).grid;
    let total = 0;
    if (this.warMode(tabKey) === 'aggregate') {
      const aggInp = row.querySelector<HTMLInputElement>('.day-score-input[data-day="' + WAR_AGGREGATE_DAY + '"]');
      const d6Inp = row.querySelector<HTMLInputElement>('.day-score-input[data-day="6"]');
      const agg = aggInp ? (parseNumber(aggInp.value) ?? 0) : 0;
      const d6 = d6Inp ? (parseNumber(d6Inp.value) ?? 0) : 0;
      total = resolvePrepChests(grid, null, agg) +
        resolveChestsForScore(grid.filter((g) => g.day === 6), d6);
    } else {
      for (let d = 1; d <= 6; d++) {
        const inp = row.querySelector<HTMLInputElement>('.day-score-input[data-day="' + d + '"]');
        const score = inp ? (parseNumber(inp.value) ?? 0) : 0;
        total += resolveChestsForScore(grid.filter((g) => g.day === d), score);
      }
    }
    const cell = row.querySelector('.player-chests-cell');
    if (cell) {
      cell.innerHTML = total
        ? renderBadge({ text: formatNumber(total), tone: 'glory', style: 'soft', size: 'sm', title: formatNumber(total) })
        : '-';
    }
  }

  private async confirmAggregateConversion(_tabKey: string, pseudo: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      openDialog({
        title: t('war_confirm_total_replaces_days'),
        iconClass: 'ph-warning',
        tone: 'danger',
        subtitle: escapeHTML(pseudo),
        body: '<strong>' + escapeHTML(pseudo) + '</strong><br>' + escapeHTML(t('war_col_total_d15')),
        confirmLabel: t('confirm_ok'),
        cancelLabel: t('confirm_cancel'),
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        onClose: () => resolve(false),
        initialFocus: null
      });
    });
  }

  private revertRowInputs(tabKey: string, row: Element | null, pseudo: string): void {
    const byDay: Record<number, number> = {};
    const entries = this.getWar(tabKey).daily[pseudo] || [];
    for (const entry of entries) byDay[entry.day] = entry.score;
    if (row) {
      row.querySelectorAll('.day-score-input').forEach((node) => {
        const inp = node as HTMLInputElement;
        if (inp.getAttribute('data-pseudo') !== pseudo) return;
        const day = Number(inp.getAttribute('data-day'));
        const v = byDay[day];
        inp.value = v !== undefined ? String(v) : '';
      });
      this.updateChestCell(row, tabKey);
    }
  }

  private async saveGranularRow(tabKey: string, pseudo: string, row: Element | null): Promise<void> {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    let inputs: HTMLInputElement[] = [];
    if (row) {
      inputs = Array.from(row.querySelectorAll('.day-score-input'));
    } else {
      const el = this.getContentEl(tabKey);
      inputs = el ? Array.from(el.querySelectorAll('.day-score-input')) : [];
    }
    if (inputs.length === 0) return;

    const war = this.getWar(tabKey);
    const existing = war.daily[pseudo] || [];
    const rows: Array<{ pseudo: string; day: number; score: number }> = [];
    inputs.forEach((inp) => {
      if (inp.getAttribute('data-pseudo') !== pseudo) return;
      const day = Number(inp.getAttribute('data-day'));
      if (!(day >= 0 && day <= 6)) return;
      const raw = (inp.value || '').trim();
      const hadPrevious = existing.some((e) => e.day === day && (Number(e.score) || 0) > 0);
      if (raw !== '') {
        const score = Number(parseNumber(raw) || 0);
        rows.push({ pseudo, day, score });
      } else if (hadPrevious) {
        rows.push({ pseudo, day, score: 0 });
      }
    });
    if (rows.length === 0) return;

    const prevHasDaily = existing.some((e) => PREP_DAYS.indexOf(e.day) !== -1 && (Number(e.score) || 0) > 0);
    const prevHasAgg = existing.some((e) => e.day === WAR_AGGREGATE_DAY);
    const wroteAgg = rows.some((r) => r.day === WAR_AGGREGATE_DAY && r.score > 0);
    const wroteDaily = rows.some((r) => PREP_DAYS.indexOf(r.day) !== -1 && r.score > 0);

    // Destructive conversion (aggregate on top of existing D1..D5): the RPC
    // clears the player's per-day scores, so require an explicit confirmation.
    if (wroteAgg && prevHasDaily) {
      const confirmed = await this.confirmAggregateConversion(tabKey, pseudo);
      if (!confirmed) {
        this.revertRowInputs(tabKey, row, pseudo);
        return;
      }
    }

    const rowGuild = this.currentGuild();
    if (!rowGuild) {
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    const res = await EventsService.upsertDailyScores(
      rowGuild,
      s.activeEventName as WarEventName,
      s.sessionId,
      rows
    );
    if (!res.ok) {
      showToast(t('war_save_tiers_error') + (res.error && res.error !== 'rpc_failed' ? ' ' + res.error : ''), 'error');
      return;
    }

    const isNowAgg = rows.some((r) => r.day === WAR_AGGREGATE_DAY && r.score > 0);
    const isNowDaily = rows.some((r) => PREP_DAYS.indexOf(r.day) !== -1 && r.score > 0);

    let nextDaily: Array<{ day: number; score: number; chests_unlocked: number }> = [];
    if (isNowAgg) {
      nextDaily = existing.filter((d) => PREP_DAYS.indexOf(d.day) === -1);
    } else if (isNowDaily) {
      nextDaily = existing.filter((d) => d.day !== WAR_AGGREGATE_DAY);
    } else {
      nextDaily = [...existing];
    }
    rows.forEach((r) => {
      const chests = r.day === WAR_AGGREGATE_DAY
        ? resolveChestsForScore(aggregateTierSlice(war.grid), r.score)
        : resolveChestsForScore(war.grid.filter((g) => g.day === r.day), r.score);
      const idx = nextDaily.findIndex((d) => d.day === r.day);
      if (idx >= 0) {
        nextDaily[idx] = { day: r.day, score: r.score, chests_unlocked: chests };
      } else {
        nextDaily.push({ day: r.day, score: r.score, chests_unlocked: chests });
      }
    });
    war.daily[pseudo] = nextDaily;

    const pp = s.participants.find((x) => x.pseudo === pseudo);
    if (pp) {
      const dailyList = war.daily[pseudo] || [];
      const prepSum = dailyList.reduce((acc, d) => (d.day >= 0 && d.day <= 5 ? acc + (Number(d.score) || 0) : acc), 0);
      const pvpSum = dailyList.reduce((acc, d) => (d.day === 6 ? acc + (Number(d.score) || 0) : acc), 0);
      pp.score_prep = prepSum;
      pp.score_pvp = pvpSum;
      if (prepSum > 0 || pvpSum > 0) pp.participated = 1;
    }

    if (row) {
      const partCb = row.querySelector('.participation-checkbox:not(.appointed-checkbox)') as HTMLInputElement | null;
      if (partCb && !partCb.checked && rows.some((r) => r.score > 0)) {
        partCb.checked = true;
        row.classList.add('participated');
      }
    }

    if (wroteAgg && prevHasDaily) {
      showToast(t('war_toast_total_replaced_days'), 'success');
    } else if (wroteDaily && prevHasAgg) {
      showToast(t('war_toast_days_replaced_total'), 'info');
    } else {
      showToast(t('war_save_daily_success'), 'success');
    }

    const contentEl = this.getContentEl(tabKey);
    if (row) this.updateChestCell(row, tabKey);
    if (contentEl) this.refreshStats(contentEl, tabKey);
  }

  // ── Save participation / score ────────────────────────────────────────────
  private async saveParticipation(tabKey: string, pseudo: string, value: number): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    const currentG = this.currentGuild();
    await setParticipantParticipation(db, currentG, s.activeEventName, s.sessionId, pseudo, value);
  }

  private async saveAppointed(tabKey: string, pseudo: string, value: boolean): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    const currentG = this.currentGuild();
    await setParticipantAppointed(db, currentG, s.activeEventName, s.sessionId, pseudo, value);
  }

  private async saveScoreField(tabKey: string, pseudo: string, field: string, value: unknown): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    const currentG = this.currentGuild();
    const num = Number(parseNumber(value as string | number | null | undefined) || 0);
    const update: Record<string, unknown> = {};
    update[field] = num;
    if (num > 0) {
      update.participated = 1;
    }
    const updateRes = await updateParticipantScore(db, currentG, s.activeEventName, s.sessionId, pseudo, update);
    if (updateRes.error) {
      showToast('Error: ' + updateRes.error.message, 'error');
    } else {
      showToast(t('toast_member_updated') || 'Updated successfully', 'success');
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  private getPanel(tabKey: string): HTMLElement | null {
    return document.getElementById(PANEL_MAP[tabKey]);
  }
  private getContentEl(tabKey: string): Element | null {
    const p = this.getPanel(tabKey);
    return p ? p.querySelector('.event-participants-area') : null;
  }

  private async editEventSchedule(tabKey: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    const currentG = this.currentGuild();
    try {
      const res = await fetchEventStartAt(db, currentG, s.activeEventName);
      if (res.error) throw res.error;

      const currentStartAt = res.data ? res.data.start_at : null;

      pickEventStart({
        eventLabel: s.activeEventName + ' - ' + t('edit_title'),
        defaultVal: currentStartAt
      }, async (startAt: string | null) => {
        if (!startAt) return;
        try {
          // One transaction (M4a): status and participants move together, and
          // an SvS/GvG war session with its daily scores follows a change of
          // week (they used to stay behind on the old session id).
          const newSessionId = buildEventSessionId(s.activeEventName as string, new Date(startAt), []);
          const moved = await EventsService.rescheduleSession(s.activeEventName as string, s.sessionId, newSessionId, startAt);
          s.sessionId = moved.session_id;

          showToast(t('toast_member_updated'), 'success');
          notifyDiscordEvent(s.activeEventName as string, startAt, 'edit');
          await this.loadEvent(tabKey);
        } catch (err: any) {
          console.error('editEventSchedule update', err);
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
      });
    } catch (err: any) {
      console.error('editEventSchedule fetch', err);
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private deleteEventSession(tabKey: string): void {
    const db = getClient();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    showConfirm(
      t('confirm_delete_session_title'),
      '<strong>' + escapeHTML(s.activeEventName) + '</strong><br>' + t('confirm_delete_session_body'),
      async () => {
        try {
          // Participants and status, in one transaction (M4a).
          await EventsService.deleteSession(s.activeEventName as string, s.sessionId);

          showToast(t('toast_session_deleted'), 'success');
          s.activeEventName = null;
          s.sessionId = null;
          s.stage = null;
          s.isActive = false;
          this.renderStatus(tabKey);
          this.renderInactive(tabKey);
        } catch (err: any) {
          console.error('deleteEventSession', err);
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
      }
    );
  }

  private renderStatus(tabKey: string): void {
    const panel = this.getPanel(tabKey);
    if (!panel) return;
    const s = this.state[tabKey];
    const badge = panel.querySelector('.event-status-badge');
    const actionsDiv = panel.querySelector('.gm-event-actions');
    const stageBadge = panel.querySelector('.arms-stage-badge');

    if (badge) {
      badge.className = 'event-status-badge gm-chip' + (s.isActive ? ' gm-chip-success active' : '');
      badge.innerHTML = '<span class="gm-dot"></span> ' + (s.isActive ? t('event_active') : t('event_inactive'));
    }

    const statusLine = panel.querySelector('.gm-event-status-line');
    if (statusLine) {
      let dimSpan = statusLine.querySelector('.gm-dim-time') as HTMLElement | null;
      if (!dimSpan) {
        dimSpan = document.createElement('span');
        dimSpan.className = 'gm-dim gm-dim-time';
        dimSpan.style.fontSize = '0.8rem';
        dimSpan.style.color = 'var(--text-muted)';
        dimSpan.style.marginLeft = '0.5rem';
        statusLine.appendChild(dimSpan);
      }
      dimSpan.textContent = (s.isActive && s.startAt) ? ' · ' + formatDateTimeUTC(s.startAt) : '';
    }

    if (actionsDiv) {
      const eventNameAttr = tabKey;
      if (s.isActive) {
        actionsDiv.innerHTML =
          '<button class="gm-btn gm-btn-danger event-end-btn" data-event="' + escapeHTML(eventNameAttr) + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>' +
          '<button class="gm-btn event-edit-sched-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-event="' + escapeHTML(eventNameAttr) + '" title="' + t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + t('edit_title') + '</span></button>' +
          '<button class="gm-btn event-delete-session-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-event="' + escapeHTML(eventNameAttr) + '" title="' + t('delete_title') + '"><i class="ph ph-trash"></i></button>';

        const endBtnDyn = actionsDiv.querySelector('.event-end-btn');
        if (endBtnDyn) endBtnDyn.addEventListener('click', () => { void this.endEvent(tabKey); });
        const editBtnDyn = actionsDiv.querySelector('.event-edit-sched-btn');
        if (editBtnDyn) editBtnDyn.addEventListener('click', () => { void this.editEventSchedule(tabKey); });
        const deleteBtnDyn = actionsDiv.querySelector('.event-delete-session-btn');
        if (deleteBtnDyn) deleteBtnDyn.addEventListener('click', () => { this.deleteEventSession(tabKey); });
      } else {
        actionsDiv.innerHTML =
          '<button class="gm-btn gm-btn-success event-start-btn" data-event="' + escapeHTML(eventNameAttr) + '" style="margin-right: 0.25rem;"><i class="ph ph-play"></i> <span>' + t('event_start') + '</span></button>' +
          '<button class="gm-btn gm-btn-danger event-end-btn" data-event="' + escapeHTML(eventNameAttr) + '" disabled><i class="ph ph-stop-circle"></i> <span>' + t('event_end') + '</span></button>';

        const startBtnDyn = actionsDiv.querySelector('.event-start-btn');
        if (startBtnDyn) {
          startBtnDyn.addEventListener('click', () => {
            if (SCHEDULED_TABS.indexOf(tabKey) !== -1) {
              pickEventStart({ eventLabel: tabKey }, (startAt: string | null) => {
                if (!startAt) return;
                void this.startEvent(tabKey, tabKey, null, startAt);
              });
            } else {
              void this.startEvent(tabKey, tabKey, null);
            }
          });
        }
      }
    }

    if (stageBadge) {
      stageBadge.classList.add('hidden');
      stageBadge.textContent = '';
    }
  }

  private renderInactive(tabKey: string): void {
    const el = this.getContentEl(tabKey);
    if (!el) return;
    el.innerHTML =
      '<div class="gm-empty">' +
        '<i class="ph ph-rocket-launch gm-icon"></i>' +
        '<div class="gm-empty-title">' + t('event_not_active') + '</div>' +
        '<div class="gm-empty-hint">' + t('event_not_active_hint') + '</div>' +
      '</div>';
  }

  private renderParticipants(tabKey: string): void {
    const el = this.getContentEl(tabKey);
    if (!el) return;
    const s = this.state[tabKey];
    const participants = s.participants;
    const dbEventName = s.activeEventName;

    if (!participants.length) {
      el.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
      return;
    }

    const isSvsOrGvg = dbEventName === 'SvS' || dbEventName === 'GvG';
    const isDtr = dbEventName === 'Defend Trade Route';
    const hasScore = EVENTS_WITHOUT_SCORE.indexOf(dbEventName as string) === -1;
    const granular = isSvsOrGvg && this.isGranular(tabKey);
    const prepMode = granular ? this.warMode(tabKey) : 'detailed';
    const done = participants.reduce((a, p) => a + (p.participated || 0), 0);
    const appointedCount = participants.reduce((a, p) => a + (p.appointed ? 1 : 0), 0);
    const totalScore = granular
      ? this.warTotalScore(tabKey)
      : isSvsOrGvg
        ? participants.reduce((a, p) => a + (p.score_prep || 0) + (p.score_pvp || 0) + (p.score || 0), 0)
        : participants.reduce((a, p) => a + (p.score || 0), 0);

    const pendingCount = participants.reduce((a, p) => a + (p.is_pending ? 1 : 0), 0);
    const approveAllBtn = pendingCount > 0
      ? '<button type="button" class="gm-btn gm-btn-sm gm-btn-success approve-all-btn" style="margin-left: auto; font-size: var(--fs-sm); padding: 0.25rem 0.5rem;"><i class="ph ph-check-square"></i> Approve All (' + pendingCount + ')</button>'
      : '';

    let html =
      '<div class="gm-row" style="gap:.5rem; margin-bottom:1rem; flex-wrap:wrap; justify-content:space-between; align-items: center;">' +
        '<div class="gm-row event-stats" style="gap:.5rem; flex-wrap:wrap; align-items: center; flex: 1;">' +
          '<span class="gm-chip"><i class="ph ph-users"></i> ' + participants.length + ' ' + t('event_total') + '</span>' +
          '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> ' + done + ' ' + t('event_participated') + '</span>' +
          '<span class="gm-chip"><i class="ph ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent') + '</span>' +
          (isDtr ? '<span class="gm-chip gm-chip-accent"><i class="ph ph-check-square"></i> ' + appointedCount + ' Appointed</span>' : '') +
          (hasScore ? '<span class="gm-chip gm-chip-accent" title="' + escapeHTML(formatNumber(totalScore)) + '"><i class="ph ph-trophy"></i> ' + t('event_total_score') + ' ' + formatCompactNumber(totalScore) + '</span>' : '') +
          approveAllBtn +
        '</div>' +
        '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
          '<i class="ph ph-magnifying-glass gm-icon"></i>' +
          '<input type="text" class="gm-input event-search-input" placeholder="' + t('search_placeholder') + '">' +
          '<button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search" tabindex="-1"><i class="ph ph-x-circle"></i></button>' +
        '</div>' +
        '</div>' +
      '<div class="gm-table-wrap gm-ui-table-wrap"><div class="gm-table-scroll">' +
      '<table class="gm-table gm-resp-table gm-ui-table-el gm-ui-table-sticky">' +
        '<thead><tr>' +
          '<th>' + t('col_member') + '</th>' +
          '<th class="gm-center">' + t('col_participated') + '</th>' +
          (isDtr ? '<th class="gm-center">Appointed</th>' : '') +
          (granular
            ? (prepMode === 'aggregate'
                ? '<th class="gm-right">' + t('war_col_total_d15') + '</th><th class="gm-right">' + t('war_day_n').replace('{day}', '6') + '</th>'
                : [1, 2, 3, 4, 5, 6].map((d) =>
                    '<th class="gm-right">' + t('war_day_n').replace('{day}', String(d)) + '</th>'
                  ).join('')) +
              '<th class="gm-right">' + t('war_col_chests') + '</th>'
            : (isSvsOrGvg
              ? '<th class="gm-right">' + t('col_score_prep') + '</th><th class="gm-right">' + t('col_score_pvp') + '</th>'
              : (hasScore ? '<th class="gm-right">' + t('col_score') + '</th>' : ''))) +
          (pendingCount > 0 ? '<th class="gm-center">Actions</th>' : '') +
        '</tr></thead><tbody>';

    participants.forEach((p) => {
      const isChecked = p.participated > 0;
      const isAppointedChecked = !!p.appointed;
      const initial = avatarInit(p.pseudo);

      let granularCells = '';
      if (granular) {
        const entries = this.getWar(tabKey).daily[p.pseudo] || [];
        const dayScores: Record<number, number> = {};
        for (const e of entries) dayScores[e.day] = e.score;
        const grid = this.getWar(tabKey).grid;
        let chestTotal = 0;
        if (prepMode === 'aggregate') {
          const agg = dayScores[WAR_AGGREGATE_DAY];
          const d6 = dayScores[6];
          granularCells += '<td class="gm-right" data-label="' + t('war_col_total_d15') + '">' +
            '<input type="text" inputmode="numeric" class="gm-score-input day-score-input" data-pseudo="' + escapeHTML(p.pseudo) + '" data-day="0" value="' + (agg != null ? formatNumber(agg) : '') + '" placeholder="-">' +
          '</td>';
          granularCells += '<td class="gm-right" data-label="Day 6">' +
            '<input type="text" inputmode="numeric" class="gm-score-input day-score-input" data-pseudo="' + escapeHTML(p.pseudo) + '" data-day="6" value="' + (d6 != null ? formatNumber(d6) : '') + '" placeholder="-">' +
          '</td>';
          chestTotal = resolvePrepChests(grid, dayScores, agg) +
            resolveChestsForScore(grid.filter((g) => g.day === 6), d6);
        } else {
          for (let d = 1; d <= 6; d++) {
            const v = dayScores[d];
            granularCells += '<td class="gm-right" data-label="Day ' + d + '">' +
              '<input type="text" inputmode="numeric" class="gm-score-input day-score-input" data-pseudo="' + escapeHTML(p.pseudo) + '" data-day="' + d + '" value="' + (v != null ? formatNumber(v) : '') + '" placeholder="-">' +
            '</td>';
          }
          for (let d = 1; d <= 6; d++) {
            chestTotal += resolveChestsForScore(grid.filter((g) => g.day === d), dayScores[d]);
          }
        }
        granularCells += '<td class="gm-right player-chests-cell" title="' + escapeHTML(formatNumber(chestTotal || 0)) + '">' +
          (chestTotal
            ? renderBadge({ text: formatNumber(chestTotal), tone: 'glory', style: 'soft', size: 'sm', title: formatNumber(chestTotal) })
            : '-') +
        '</td>';
      }

      const rowClass = 'participant-row' + (isChecked ? ' participated' : '') + (p.is_pending ? ' pending-approval-row' : '');
      const rowStyle = p.is_pending ? 'background: rgba(245, 158, 11, 0.05); border-left: 3px solid var(--warning);' : '';

      const actionBtn = p.is_pending
        ? '<button type="button" class="gm-btn gm-btn-success approve-single-btn" data-pseudo="' + escapeHTML(p.pseudo) + '" style="font-size: var(--fs-sm); padding:0.2rem 0.4rem; display:inline-flex; align-items:center; gap:0.25rem;"><i class="ph ph-check"></i> Approve</button>'
        : '';

      html +=
        '<tr class="' + rowClass + '" style="' + rowStyle + '" data-pseudo="' + escapeHTML(p.pseudo) + '">' +
          '<td data-label="' + t('col_member') + '">' +
            '<div class="gm-row" style="gap:.6rem;">' +
              '<div class="gm-avatar">' + escapeHTML(initial) + '</div>' +
              '<strong style="display:inline-flex; align-items:center; gap:0.4rem;">' +
                escapeHTML(p.pseudo) +
                (p.is_pending ? '<span class="gm-chip" style="font-size: var(--fs-2xs); padding:0.05rem 0.25rem; background:rgba(245,158,11,0.1); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending</span>' : '') +
              '</strong>' +
            '</div>' +
          '</td>' +
          '<td class="gm-center" data-label="' + t('col_participated') + '">' +
            '<label class="check-toggle">' +
              '<input type="checkbox" class="participation-checkbox" data-pseudo="' + escapeHTML(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
              '<span class="check-slider"></span>' +
            '</label>' +
          '</td>' +
          (isDtr
            ? '<td class="gm-center" data-label="Appointed">' +
                '<label class="check-toggle">' +
                  '<input type="checkbox" class="participation-checkbox appointed-checkbox" data-pseudo="' + escapeHTML(p.pseudo) + '"' + (isAppointedChecked ? ' checked' : '') + '>' +
                  '<span class="check-slider"></span>' +
                '</label>' +
              '</td>'
            : '') +
          (granular
            ? granularCells
            : (isSvsOrGvg
              ? '<td class="gm-right" data-label="' + t('col_score_prep') + '">' +
                  '<input type="text" inputmode="numeric" class="gm-score-input score-input-prep" value="' + (p.score_prep != null ? formatNumber(p.score_prep) : '') + '" placeholder="-" data-pseudo="' + escapeHTML(p.pseudo) + '">' +
                '</td>' +
                '<td class="gm-right" data-label="' + t('col_score_pvp') + '">' +
                  '<input type="text" inputmode="numeric" class="gm-score-input score-input-pvp" value="' + (p.score_pvp != null ? formatNumber(p.score_pvp) : '') + '" placeholder="-" data-pseudo="' + escapeHTML(p.pseudo) + '">' +
                '</td>'
              : (hasScore ? '<td class="gm-right" data-label="' + t('col_score') + '">' +
                  '<input type="text" inputmode="numeric" class="gm-score-input score-input" value="' + (p.score != null ? formatNumber(p.score) : '') + '" placeholder="-" data-pseudo="' + escapeHTML(p.pseudo) + '">' +
                '</td>' : ''))) +
          (pendingCount > 0 ? '<td class="gm-center" data-label="Actions">' + actionBtn + '</td>' : '') +
        '</tr>';
    });

    html += '</tbody></table></div></div>';
    el.innerHTML = html;

    el.querySelectorAll('.participation-checkbox:not(.appointed-checkbox)').forEach((cbe) => {
      const cb = cbe as HTMLInputElement;
      cb.addEventListener('change', () => {
        const next = cb.checked ? 1 : 0;
        const row = cb.closest('.participant-row');
        if (row) row.classList.toggle('participated', cb.checked);

        const pseudo = cb.getAttribute('data-pseudo') || '';
        void this.saveParticipation(tabKey, pseudo, next).then(() => {
          const pp = this.state[tabKey].participants.find((x) => x.pseudo === pseudo);
          if (pp) pp.participated = next;
          this.refreshStats(el, tabKey);
        });
      });
    });

    el.querySelectorAll('.appointed-checkbox').forEach((cbe) => {
      const cb = cbe as HTMLInputElement;
      cb.addEventListener('change', () => {
        const pseudo = cb.getAttribute('data-pseudo') || '';
        const row = cb.closest('.participant-row');
        const partCb = row ? row.querySelector('.participation-checkbox:not(.appointed-checkbox)') as HTMLInputElement | null : null;

        const pp = this.state[tabKey].participants.find((x) => x.pseudo === pseudo);
        const promises: Promise<any>[] = [];

        if (cb.checked && partCb && !partCb.checked) {
          partCb.checked = true;
          if (row) row.classList.add('participated');
          promises.push(this.saveParticipation(tabKey, pseudo, 1).then(() => { if (pp) pp.participated = 1; }));
        }

        promises.push(this.saveAppointed(tabKey, pseudo, cb.checked).then(() => { if (pp) pp.appointed = cb.checked; }));

        Promise.all(promises).then(() => { this.refreshStats(el, tabKey); });
      });
    });

    const wireScoreInputs = (selector: string, field: string, stateKey: string): void => {
      el.querySelectorAll(selector).forEach((el2) => {
        const inp = el2 as HTMLInputElement;
        attachNumberFormatter(inp);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const triggerSave = (): void => {
          clearTimeout(timer);
          const pseudo = inp.getAttribute('data-pseudo') || '';
          void this.saveScoreField(tabKey, pseudo, field, inp.value).then(() => {
            const pp = this.state[tabKey].participants.find((x) => x.pseudo === pseudo);
            const num = Number(parseNumber(inp.value) || 0);
            if (pp) {
              pp[stateKey] = num;
              if (num > 0) pp.participated = 1;
            }
            const row = inp.closest('.participant-row');
            if (row && num > 0) {
              const cb = row.querySelector('.participation-checkbox:not(.appointed-checkbox)') as HTMLInputElement | null;
              if (cb && !cb.checked) {
                cb.checked = true;
                row.classList.add('participated');
              }
            }
            this.refreshStats(el, tabKey);
          });
        };
        inp.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            triggerSave();
          }, 700);
        });
        inp.addEventListener('change', () => {
          triggerSave();
        });
      });
    };

    if (granular) {
      this.wireGranularInputs(el, tabKey);
    } else {
      wireScoreInputs('.score-input', 'score', 'score');
      wireScoreInputs('.score-input-prep', 'score_prep', 'score_prep');
      wireScoreInputs('.score-input-pvp', 'score_pvp', 'score_pvp');
    }

    const searchInput = el.querySelector('.event-search-input') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.toLowerCase();
        el.querySelectorAll('.participant-row').forEach((row) => {
          const pseudo = (row.getAttribute('data-pseudo') || '').toLowerCase();
          const uid = (this.uidMap[row.getAttribute('data-pseudo') || ''] || '').toLowerCase();
          (row as HTMLElement).style.display = (pseudo + ' ' + uid).indexOf(q) !== -1 ? '' : 'none';
        });
      });
    }

    el.querySelectorAll('.approve-single-btn').forEach((btne) => {
      const btn = btne as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        const pseudo = btn.getAttribute('data-pseudo') || '';
        btn.disabled = true;
        btn.textContent = '...';
        try {
          const db = getClient();
          const rpcRes = await approveParticipantSubmission(db, this.currentGuild(), s.activeEventName, s.sessionId, pseudo);
          if (rpcRes.error) throw rpcRes.error;
          const data = rpcRes.data;
          const ok = data && (data.ok !== false);
          if (!ok) throw new Error((data && data.error) || 'approve_failed');

          const pp = this.state[tabKey].participants.find((x) => x.pseudo === pseudo);
          if (pp) pp.is_pending = false;
          this.renderParticipants(tabKey);
          await this.fetchParticipants(tabKey);
        } catch (err) {
          console.error('approve single', err);
          showToast('Failed to approve submission.', 'error');
          btn.disabled = false;
          btn.textContent = 'Approve';
        }
      });
    });

    const approveAllBtnEl = el.querySelector('.approve-all-btn') as HTMLButtonElement | null;
    if (approveAllBtnEl) {
      approveAllBtnEl.addEventListener('click', async () => {
        approveAllBtnEl.disabled = true;
        approveAllBtnEl.textContent = 'Approving...';
        const pendingPseudos = this.state[tabKey].participants.filter((p) => p.is_pending).map((p) => p.pseudo);
        try {
          // Approve every pending player via the SECURITY DEFINER RPC, in
          // parallel batches instead of one request at a time.
          const activeGuildForApproval = this.currentGuild();
          await runInChunks(pendingPseudos, 10, async (pseudo: string) => {
            const db = getClient();
            const rpcRes = await approveParticipantSubmission(db, activeGuildForApproval, s.activeEventName, s.sessionId, pseudo);
            if (rpcRes.error) throw rpcRes.error;
          });
          this.state[tabKey].participants.forEach((p) => { if (p.is_pending) p.is_pending = false; });
          this.renderParticipants(tabKey);
          await this.fetchParticipants(tabKey);
        } catch (err) {
          console.error('approve all', err);
          showToast('Failed to approve all submissions.', 'error');
          approveAllBtnEl.disabled = false;
          approveAllBtnEl.textContent = 'Approve All (' + pendingCount + ')';
        }
      });
    }
  }

  private refreshStats(el: Element, tabKey: string): void {
    const participants = this.state[tabKey].participants;
    const isSvsOrGvg = this.state[tabKey].activeEventName === 'SvS' || this.state[tabKey].activeEventName === 'GvG';
    const granular = isSvsOrGvg && this.isGranular(tabKey);
    const done = participants.reduce((a, p) => a + (p.participated || 0), 0);
    const totalScore = granular
      ? this.warTotalScore(tabKey)
      : isSvsOrGvg
        ? participants.reduce((a, p) => a + (p.score_prep || 0) + (p.score_pvp || 0) + (p.score || 0), 0)
        : participants.reduce((a, p) => a + (p.score || 0), 0);
    const chips = el.querySelectorAll('.event-stats .gm-chip');
    if (chips[1]) chips[1].innerHTML = '<i class="ph ph-check-circle"></i> ' + done + ' ' + t('event_participated');
    if (chips[2]) chips[2].innerHTML = '<i class="ph ph-x-circle"></i> ' + (participants.length - done) + ' ' + t('event_absent');

    const isDtr = this.state[tabKey].activeEventName === 'Defend Trade Route';
    if (isDtr) {
      const appointedCount = participants.reduce((a, p) => a + (p.appointed ? 1 : 0), 0);
      if (chips[3]) chips[3].innerHTML = '<i class="ph ph-check-square"></i> ' + appointedCount + ' Appointed';
    } else {
      const hasScore = EVENTS_WITHOUT_SCORE.indexOf(this.state[tabKey].activeEventName as string) === -1;
      if (hasScore && chips[3]) {
        chips[3].innerHTML = '<i class="ph ph-trophy"></i> ' + t('event_total_score') + ' ' + formatNumber(totalScore);
      }
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_EVENTS` at cutover). */
export const eventsView = new EventsView();

export default eventsView;
