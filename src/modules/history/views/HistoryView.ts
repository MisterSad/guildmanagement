/**
 * src/modules/history/views/HistoryView.ts
 *
 * Strangler Phase 1 port of the root `history.js` (694 lines): aggregated
 * session list (RPC `gm_list_event_sessions` + Glory fallback), timeline cards,
 * filter pills, and the session detail/edit modal.
 *
 * Strict invariants preserved from the legacy script (guarded by existing
 * tests): the 15s cache TTL (`isFresh`/`markFresh`), the `historyLoading`
 * anti-reentrance flag, and the `ALLOWED_HISTORY_FIELDS` edit whitelist.
 *
 * This module never assigns `window.GM_HISTORY` (bridge added at cutover).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  EVENT_META,
  FILTERS,
  HISTORY_CACHE_TTL_MS,
  ALLOWED_HISTORY_FIELDS,
  hasSessionDate,
  parseSessionDate,
  formatSessionDate,
  pad2,
  getWeekNumber,
  getCategoryEventNames,
  filterSessions,
  sortSessionsDesc,
  clearEventHistory,
  deleteHistorySession,
  listEventSessions,
  listAllWarSessions,
  fetchGloryParticipantRows,
  fetchSessionParticipants,
  updateSessionParticipantField,
  type HistorySession
} from '../history.service';
import { EventsService, type WarEventName } from '../../events/events.service';
import { resolveChestsForScore, resolvePrepChests, WAR_AGGREGATE_DAY } from '../../../core/scoring/chests';
import { openDialog, closeDialog } from '../../../components/ui/Dialog';
import type { ChestTier } from '../../../types/database';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild, roleFromStorage } from '../../../core/auth/roles';
import { isFresh, markFresh } from '../../../core/cache/cache';
import { buildEventSessionId, getEventIcon, getEventTheme } from '../../../core/config/events';
import { showToast } from '../../../core/dom/toast';
import { attachNumberFormatter } from '../../../core/dom/ui';
import { t } from '../../../core/i18n/i18n';
import { formatWeek } from '../../../core/utils/date';
import { avatarInit, escapeHTML, formatNumber, parseNumber } from '../../../core/utils/text';
import { showConfirm } from '../../app/dialogs/dialogs.service';

export class HistoryView {
  private sessions: HistorySession[] = [];
  private activeFilter = 'All';
  private historyLoading = false;
  private warSessions: Record<string, any> = {};

  public getState(): { sessions: HistorySession[]; activeFilter: string } {
    return { sessions: this.sessions, activeFilter: this.activeFilter };
  }

  public async load(): Promise<void> {
    const db = getClient();
    if (!db) return;

    const currentG = getActiveGuild();
    const cacheKey = 'history:' + currentG;
    if (isFresh(cacheKey, HISTORY_CACHE_TTL_MS)) return;
    if (this.historyLoading) return;
    this.historyLoading = true;

    try {
      const res = await listEventSessions(db, currentG);
      if (res.error) {
        console.error('gm_list_event_sessions', res.error);
        this.render();
        return;
      }
      this.sessions = (res.data || []) as HistorySession[];

      // War metadata (opponent + daily results) for SvS/GvG cards/modal.
      const warRes = await listAllWarSessions(db, currentG);
      if (!warRes.error && warRes.data && warRes.data.ok && Array.isArray(warRes.data.sessions)) {
        this.warSessions = {};
        (warRes.data.sessions as any[]).forEach((ws) => {
          this.warSessions[(ws.event_name || '') + ':' + (ws.session_id || '')] = ws;
        });
      }

      // Manual fetch for Glory if not returned by the sessions RPC.
      const hasGlory = this.sessions.some((s) => s.event_name === 'Glory');
      if (!hasGlory) {
        const gloryRes = await fetchGloryParticipantRows(db, currentG);

        if (!gloryRes.error && gloryRes.data && gloryRes.data.length > 0) {
          const gloryMap: Record<string, any> = {};
          const seenPseudo: Record<string, Set<string>> = {};
          (gloryRes.data as any[]).forEach((row) => {
            const ws = row.week_start;
            if (!gloryMap[ws]) {
              gloryMap[ws] = {
                event_name: 'Glory',
                session_id: buildEventSessionId('Glory', ws),
                week_start: ws,
                participants: 0,
                participated_count: 0,
                total_score: 0
              };
              seenPseudo[ws] = new Set<string>();
            }
            if (row.pseudo && seenPseudo[ws].has(row.pseudo)) return;
            if (row.pseudo) seenPseudo[ws].add(row.pseudo);

            gloryMap[ws].participants++;
            if (row.participated > 0 || (row.score != null && row.score > 0)) gloryMap[ws].participated_count++;
            if (row.score > 0) gloryMap[ws].total_score += row.score;
          });
          this.sessions = this.sessions.concat(Object.values(gloryMap));
        }
      }

      this.sessions = sortSessionsDesc(this.sessions);
      markFresh(cacheKey);
      this.render();
    } catch (err) {
      console.error('loadHistory', err);
      this.render();
    } finally {
      this.historyLoading = false;
    }
  }

  public render(): void {
    const area = document.querySelector('#event-history .history-area');
    if (!area) return;

    const filtered = filterSessions(this.sessions, this.activeFilter);

    const pillsHtml = '<div class="gm-tabs-pill-row" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1.5rem;">' +
      '<div class="gm-tabs-pill" style="margin:0;">' +
        FILTERS.map((f) => {
          const isActive = (f === this.activeFilter);
          const label = (f === 'All') ? t('history_filter_all') : f;
          const iconClass = (f === 'All') ? 'ph-circles-four' : getEventIcon(f);
          return '<button class="gm-tab-pill history-filter' + (isActive ? ' gm-active' : '') + '" data-filter="' + escapeHTML(f) + '">' +
            '<i class="ph ' + iconClass + '"></i> ' + escapeHTML(label) +
          '</button>';
        }).join('') +
      '</div>' +
      (this.activeFilter !== 'All' && filtered.length > 0 ?
        '<button class="gm-btn gm-btn-danger history-clear-category-btn" style="font-size:0.82rem; padding:0.4rem 0.85rem; display:inline-flex; align-items:center; gap:0.4rem;" data-filter="' + escapeHTML(this.activeFilter) + '" data-count="' + filtered.length + '">' +
          '<i class="ph ph-trash"></i> <span>Delete ' + escapeHTML(this.activeFilter) + ' history (' + filtered.length + ')</span>' +
        '</button>' : ''
      ) +
    '</div>';

    if (filtered.length === 0) {
      area.innerHTML = pillsHtml +
        '<div class="gm-empty"><i class="ph ph-clock-counter-clockwise gm-icon"></i><div class="gm-empty-title">' + t('history_empty') + '</div></div>';
      this.wirePills();
      return;
    }

    let cardsHtml = '<div class="gm-timeline-container">';
    filtered.forEach((s) => {
      let displayName = s.display_name || s.event_name || '';
      if (displayName === 'Shadowfront Squad 1') displayName = 'Shadowfront Squad One';
      else if (displayName === 'Shadowfront Squad 2') displayName = 'Shadowfront Squad Two';

      const meta: any = EVENT_META[s.event_name || ''] || { icon: 'ph-calendar-dot', label: displayName, hasScore: false, border: 'var(--border-soft)' };
      meta.label = displayName;
      const iconClass = getEventIcon(s.event_name || '');
      const isWeekly = (s.event_name === 'SvS' || s.event_name === 'GvG' || s.event_name === 'Glory');
      const weekNum = getWeekNumber(s.week_start);
      const weekDisplay = 'Week ' + weekNum;
      const ratio = (s.participants || 0) > 0 ? Math.round(((s.participated_count || 0) / (s.participants as number)) * 100) : 0;
      const themeClass = getEventTheme(s.event_name || '');

      // Opponent + Won/Lost summary for SvS/GvG sessions with war metadata.
      let warMetaHtml = '';
      if (s.event_name === 'SvS' || s.event_name === 'GvG') {
        const war = this.warSessions[(s.event_name) + ':' + (s.session_id || '')];
        if (war && war.opponent_snapshot && war.opponent_snapshot.name) {
          const won = [1, 2, 3, 4, 5, 6].filter((d) => war['day' + d + '_result'] === 'won').length;
          const lost = [1, 2, 3, 4, 5, 6].filter((d) => war['day' + d + '_result'] === 'lost').length;
          const opLabel = t('war_card_opponent').replace('{name}', String(war.opponent_snapshot.name));
          let recLabel = '';
          if (won || lost) recLabel = ' · ' + t('war_card_record').replace('{w}', String(won)).replace('{l}', String(lost));
          warMetaHtml = '<div class="war-card-meta"><i class="ph ph-crosshair"></i> ' +
            escapeHTML(opLabel) + escapeHTML(recLabel) + '</div>';
        }
      }

      let leftTopStr = '';
      let leftSubStr = '';
      let subtitleText = '';

      if (isWeekly) {
        leftTopStr = weekDisplay;
        leftSubStr = '';
        subtitleText = weekDisplay + (s.week_start ? ' (' + formatWeek(s.week_start) + ')' : '');
      } else {
        const dateObj = parseSessionDate(s);
        if (dateObj && !isNaN(dateObj.getTime())) {
          leftTopStr = pad2(dateObj.getUTCDate()) + '/' + pad2(dateObj.getUTCMonth() + 1) + '/' + dateObj.getUTCFullYear();
          if (s.start_at) {
            leftSubStr = pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes()) + ' UTC';
            subtitleText = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) + ', ' + leftSubStr;
          } else {
            leftSubStr = '';
            subtitleText = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
          }
        } else {
          leftTopStr = weekDisplay;
          leftSubStr = '';
          subtitleText = weekDisplay;
        }
      }

      cardsHtml +=
        '<div class="gm-timeline-item">' +
          '<div class="gm-timeline-time-col">' +
            '<div style="font-size:0.85rem; font-weight:700;">' + escapeHTML(leftTopStr) + '</div>' +
            (leftSubStr ? '<div style="font-size:0.7rem; font-weight:500; opacity:0.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHTML(leftSubStr) + '</div>' : '') +
          '</div>' +
          '<div class="gm-timeline-line-col">' +
            '<div class="gm-timeline-dot"></div>' +
          '</div>' +
          '<div>' +
            '<div class="gm-task-card gm-history-card ' + themeClass + '" data-event="' + escapeHTML(s.event_name) + '" data-display="' + escapeHTML(displayName) + '" data-session="' + escapeHTML(s.session_id || '') + '" data-week="' + escapeHTML(s.week_start) + '" data-granular="' + (s.granular ? '1' : '0') + '">' +
              '<div class="gm-task-card-top">' +
                '<div class="gm-task-status-tag">' +
                  '<i class="ph ' + escapeHTML(iconClass) + '"></i>' +
                  '<span>' + escapeHTML(meta.label) + '</span>' +
                '</div>' +
                '<div style="display:flex; gap:0.4rem; align-items:center;">' +
                  ((s.total_score || 0) > 0 ? '<span class="gm-task-countdown-badge"><i class="ph ph-trophy"></i> ' + formatNumber(s.total_score) + '</span>' : '') +
                  '<span class="gm-task-countdown-badge">' + (s.participated_count || 0) + '/' + (s.participants || 0) + ' (' + ratio + '%)</span>' +
                '</div>' +
              '</div>' +
              '<div class="gm-task-card-body">' +
                '<div class="gm-task-icon-squircle">' +
                  '<i class="ph ' + escapeHTML(iconClass) + '"></i>' +
                '</div>' +
                '<div class="gm-task-info">' +
                  '<div class="gm-task-title">' + escapeHTML(meta.label) + '</div>' +
                  '<div class="gm-task-sub">' + escapeHTML(subtitleText) + '</div>' +
                  warMetaHtml +
                '</div>' +
                '<button class="gm-task-action-btn" title="View Session Details" aria-label="View session details">' +
                  '<i class="ph ph-caret-right" style="font-size:1.3rem;"></i>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    });
    cardsHtml += '</div>';

    area.innerHTML = pillsHtml + cardsHtml;
    this.wirePills();
    this.wireCards();
  }

  private wirePills(): void {
    document.querySelectorAll('#event-history .history-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeFilter = btn.getAttribute('data-filter') || 'All';
        this.render();
      });
    });
    const clearCategoryBtn = document.querySelector('#event-history .history-clear-category-btn');
    if (clearCategoryBtn) {
      clearCategoryBtn.addEventListener('click', () => {
        const filterKey = clearCategoryBtn.getAttribute('data-filter') || '';
        const count = clearCategoryBtn.getAttribute('data-count') || '0';
        void this.deleteCategoryHistory(filterKey, count);
      });
    }
  }

  private wireCards(): void {
    document.querySelectorAll('#event-history .gm-history-card').forEach((card) => {
      card.addEventListener('click', () => {
        const ev = card.getAttribute('data-event') || '';
        const disp = card.getAttribute('data-display') || null;
        const sid = card.getAttribute('data-session') || null;
        const week = card.getAttribute('data-week') || '';
        const granular = card.getAttribute('data-granular') === '1';
        void this.openSessionDetail(ev, disp, sid, week, granular);
      });
    });
  }

  private async deleteCategoryHistory(filterKey: string, count: string): Promise<void> {
    const eventNames = getCategoryEventNames(filterKey);

    showConfirm(
      'Delete all ' + filterKey + ' history',
      'Are you sure you want to delete the finished sessions among these <strong>' + count + '</strong> in category <strong>' + escapeHTML(filterKey) + '</strong>? A session still running is kept. This action cannot be undone.',
      async () => {
        try {
          // One transaction (M4a). Running sessions -- their participants,
          // status and squads -- and squads not yet started are spared.
          await clearEventHistory(eventNames);

          showToast(t('toast_session_deleted'), 'success');
          await this.load();
        } catch (err: any) {
          console.error('deleteCategoryHistory error', err);
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
        }
      }
    );
  }

  private async openSessionDetail(eventName: string, displayName: string | null, sessionId: string | null, weekStart: string, granular: boolean): Promise<void> {
    const db = getClient();
    if (!db) return;
    const meta: any = EVENT_META[eventName] || { label: displayName || eventName, icon: 'ph-circle', hasScore: false, border: 'var(--border-soft)' };
    if (displayName) meta.label = displayName;

    const query: any = fetchSessionParticipants(db, getActiveGuild(), eventName, weekStart, sessionId);

    const res = await query;
    if (res.error) {
      showToast(t('toast_err_generic') + ' ' + res.error.message, 'error');
      return;
    }

    const rows = (res.data || []) as any[];
    const isDualScore = (eventName === 'SvS' || eventName === 'GvG');

    // Granular mode: fetch the frozen grid + per-day scores and render the
    // 6-day columns instead of the legacy aggregated score_prep/score_pvp.
    let warExtra: { grid: ChestTier[]; daily: Record<string, Array<{ day: number; score: number; chests_unlocked: number }>> } | null = null;
    let granularActive = false;
    if (granular && sessionId && isDualScore) {
      const granularGuild = getActiveGuild();
      const [warRes, dayRes] = granularGuild
        ? await Promise.all([
            EventsService.getWarSession(granularGuild, eventName as WarEventName, sessionId),
            EventsService.getDailyScores(granularGuild, eventName as WarEventName, sessionId)
          ])
        // H2: without a tenant there is nothing to fetch; fall through to the
        // aggregated view rather than reading ALPHA's session.
        : [{ ok: false } as Awaited<ReturnType<typeof EventsService.getWarSession>>,
           { ok: false } as Awaited<ReturnType<typeof EventsService.getDailyScores>>];
      if (warRes.ok && dayRes.ok) {
        const snapshot = warRes.session
          && Array.isArray(warRes.session.chest_tiers_snapshot)
          && (warRes.session.chest_tiers_snapshot as unknown as unknown[]).length > 0
          ? (warRes.session.chest_tiers_snapshot as unknown as ChestTier[])
          : [];
        const daily: Record<string, Array<{ day: number; score: number; chests_unlocked: number }>> = {};
        dayRes.rows.forEach((r) => {
          (daily[r.pseudo] = daily[r.pseudo] || []).push({ day: r.day, score: r.score ?? 0, chests_unlocked: r.chests_unlocked ?? 0 });
        });
        warExtra = { grid: snapshot, daily };
        granularActive = true;
      }
    }

    this.renderSessionModal(eventName, sessionId, weekStart, rows, meta, isDualScore && !granularActive, granularActive, warExtra);
  }

  private async updateGranularDayField(eventName: string, sessionId: string, pseudo: string, day: number, score: number): Promise<void> {
    if (!(day >= 0 && day <= 6)) return;
    const dayGuild = getActiveGuild();
    if (!dayGuild) {
      // H2: this writes a score. Refuse rather than write into ALPHA.
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    const res = await EventsService.upsertDailyScores(
      dayGuild,
      eventName as WarEventName,
      sessionId,
      [{ pseudo, day, score }]
    );
    if (res.ok) {
      showToast(t('war_save_daily_success'), 'success');
    } else {
      showToast(t('war_save_tiers_error') + (res.error && res.error !== 'rpc_failed' ? ' ' + res.error : ''), 'error');
    }
  }

  private async updateParticipantField(eventName: string, sessionId: string | null, weekStart: string, pseudo: string, field: string, value: unknown): Promise<void> {
    // SECURITY: never allow arbitrary column writes from the History modal.
    if (ALLOWED_HISTORY_FIELDS.indexOf(field) === -1) {
      console.error('[SECURITY] Unauthorized field update attempt in history:', field);
      showToast('Invalid update field', 'error');
      return;
    }
    const db = getClient();
    if (!db) return;
    const currentG = getActiveGuild();
    const query: any = updateSessionParticipantField(db, currentG, eventName, weekStart, sessionId, pseudo, field, value);
    const updateRes = await query;
    if (updateRes.error) {
      showToast('Error: ' + updateRes.error.message, 'error');
    } else {
      showToast('Updated successfully', 'success');
    }
  }

  private renderSessionModal(
    eventName: string,
    sessionId: string | null,
    weekStart: string,
    rows: any[],
    meta: any,
    isDualScore: boolean,
    granular = false,
    warExtra: { grid: ChestTier[]; daily: Record<string, Array<{ day: number; score: number; chests_unlocked: number }>> } | null = null
  ): void {
    const existing = document.getElementById('history-modal');
    if (existing) existing.remove();

    const when = sessionId && hasSessionDate(sessionId) ? formatSessionDate(sessionId) : t('history_week_only');

    const sorted = rows.slice().sort((a, b) => {
      const ap = a.participated || 0, bp = b.participated || 0;
      if (bp !== ap) return bp - ap;
      const as = (a.score || 0) + (a.score_prep || 0) + (a.score_pvp || 0);
      const bs = (b.score || 0) + (b.score_prep || 0) + (b.score_pvp || 0);
      if (bs !== as) return bs - as;
      return String(a.pseudo).localeCompare(String(b.pseudo));
    });

    const isDtr = (eventName === 'Defend Trade Route');
    const isAdmin = (roleFromStorage() !== 'member');
    const hasGrid = granular && !!(warExtra && warExtra.grid && warExtra.grid.length > 0);

    let headerCols = '<th>' + t('col_member') + '</th>';
    const hasParticipated = (eventName !== 'Glory');
    if (hasParticipated) headerCols += '<th class="gm-center">' + t('col_participated') + '</th>';
    if (eventName === 'Shadowfront') {
      headerCols += '<th class="gm-center">Late</th><th class="gm-center">Excused</th><th class="gm-center">Sub Present</th>';
    }
    if (isDtr) headerCols += '<th class="gm-center">Appointed</th>';
    if (granular) {
      for (let d = 1; d <= 6; d++) {
        headerCols += '<th class="gm-right">' + t('war_day_n').replace('{day}', String(d)) + '</th>';
      }
      if (hasGrid) headerCols += '<th class="gm-right">' + t('war_col_chests') + '</th>';
    } else if (isDualScore) {
      headerCols += '<th class="gm-right">' + t('col_score_prep') + '</th><th class="gm-right">' + t('col_score_pvp') + '</th>';
    } else if (meta.hasScore) {
      headerCols += '<th class="gm-right">' + t('col_score') + '</th>';
    }

    const rowsHtml = sorted.map((r) => {
      const initial = avatarInit(r.pseudo);
      let participatedCell = '', lateCell = '', excusedCell = '', subPresentCell = '', appointedCell = '', scoreCells = '';

      if (hasParticipated) {
        if (isAdmin) {
          participatedCell = '<td class="gm-center" data-label="' + t('col_participated') + '"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="participated" data-pseudo="' + escapeHTML(r.pseudo) + '"' + (r.participated > 0 ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
        } else {
          participatedCell = '<td class="gm-center" data-label="' + t('col_participated') + '">' + (r.participated > 0 ? '<i class="ph ph-check-circle text-success"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
        }
      }
      if (eventName === 'Shadowfront') {
        if (isAdmin) {
          lateCell = '<td class="gm-center" data-label="Late"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="late" data-pseudo="' + escapeHTML(r.pseudo) + '"' + (r.late ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
          excusedCell = '<td class="gm-center" data-label="Excused"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="excused" data-pseudo="' + escapeHTML(r.pseudo) + '"' + (r.excused ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
          subPresentCell = '<td class="gm-center" data-label="Sub Present"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="sub_present" data-pseudo="' + escapeHTML(r.pseudo) + '"' + (r.sub_present ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
        } else {
          lateCell = '<td class="gm-center" data-label="Late">' + (r.late ? '<i class="ph ph-check-circle text-warning"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
          excusedCell = '<td class="gm-center" data-label="Excused">' + (r.excused ? '<i class="ph ph-check-circle text-info"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
          subPresentCell = '<td class="gm-center" data-label="Sub Present">' + (r.sub_present ? '<i class="ph ph-check-circle text-accent"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
        }
      }
      if (isDtr) {
        if (isAdmin) {
          appointedCell = '<td class="gm-center" data-label="Appointed"><label class="check-toggle" style="margin: auto;"><input type="checkbox" class="hist-edit-check" data-field="appointed" data-pseudo="' + escapeHTML(r.pseudo) + '"' + (r.appointed ? ' checked' : '') + '><span class="check-slider"></span></label></td>';
        } else {
          appointedCell = '<td class="gm-center" data-label="Appointed">' + (r.appointed ? '<i class="ph ph-check-circle text-success"></i>' : '<i class="ph ph-x-circle gm-dim"></i>') + '</td>';
        }
      }

      // Granular SvS/GvG: six per-day columns (+ chests) instead of the
      // aggregated score_prep / score_pvp fields. A player in aggregate mode
      // (day-0 row) renders a single cumulative "Total D1–D5" cell instead of
      // the five empty per-day cells, with chests from resolvePrepChests.
      if (granular) {
        const dayOf: Record<number, number> = {};
        if (warExtra) {
          ((warExtra.daily[r.pseudo]) || []).forEach((e) => { dayOf[e.day] = e.score; });
        }
        const isAggregate = dayOf[WAR_AGGREGATE_DAY] !== undefined;
        let dayCells = '';
        if (isAggregate) {
          const total = dayOf[WAR_AGGREGATE_DAY];
          if (isAdmin) {
            dayCells += '<td colspan="5" class="gm-right" data-label="' + t('war_col_total_d15') + '">' +
              '<input type="text" inputmode="numeric" class="hist-edit-num hist-day-input gm-score-input" data-field="day_score" data-pseudo="' + escapeHTML(r.pseudo) + '" data-day="' + WAR_AGGREGATE_DAY + '" value="' + (total != null ? formatNumber(total) : '') + '" title="' + t('war_col_total_d15') + '"><span class="gm-dim" style="font-size:var(--fs-2xs);"> ' + t('war_col_total_d15') + '</span></td>';
          } else {
            dayCells += '<td colspan="5" class="gm-right" data-label="' + t('war_col_total_d15') + '">' + t('war_col_total_d15') + ': ' + (total != null ? formatNumber(total) : '-') + '</td>';
          }
          const d6 = dayOf[6];
          if (isAdmin) {
            dayCells += '<td class="gm-right" data-label="Day 6"><input type="text" inputmode="numeric" class="hist-edit-num hist-day-input gm-score-input" data-field="day_score" data-pseudo="' + escapeHTML(r.pseudo) + '" aria-label="' + escapeHTML('Day 6, ' + r.pseudo) + '" data-day="6" value="' + (d6 != null ? formatNumber(d6) : '') + '"></td>';
          } else {
            dayCells += '<td class="gm-right" data-label="Day 6">' + (d6 != null ? formatNumber(d6) : '-') + '</td>';
          }
          if (hasGrid && warExtra) {
            const chestTotal = resolvePrepChests(warExtra.grid, dayOf, total) +
              resolveChestsForScore(warExtra.grid.filter((g) => g.day === 6), dayOf[6]);
            dayCells += '<td class="gm-right" data-label="' + t('war_col_chests') + '">' + (chestTotal ? formatNumber(chestTotal) : '-') + '</td>';
          }
        } else {
          for (let d = 1; d <= 6; d++) {
            const v = dayOf[d];
            if (isAdmin) {
              dayCells += '<td class="gm-right" data-label="Day ' + d + '"><input type="text" inputmode="numeric" class="hist-edit-num hist-day-input gm-score-input" data-field="day_score" data-pseudo="' + escapeHTML(r.pseudo) + '" aria-label="' + escapeHTML('Day ' + d + ', ' + r.pseudo) + '" data-day="' + d + '" value="' + (v != null ? formatNumber(v) : '') + '"></td>';
            } else {
              dayCells += '<td class="gm-right" data-label="Day ' + d + '">' + (v != null ? formatNumber(v) : '-') + '</td>';
            }
          }
          if (hasGrid && warExtra) {
            let chestTotal = 0;
            for (let d = 1; d <= 6; d++) {
              chestTotal += resolveChestsForScore(warExtra.grid.filter((g) => g.day === d), dayOf[d]);
            }
            dayCells += '<td class="gm-right" data-label="' + t('war_col_chests') + '">' + (chestTotal ? formatNumber(chestTotal) : '-') + '</td>';
          }
        }
        scoreCells = dayCells;
      } else if (isAdmin) {
        if (isDualScore) {
          scoreCells = '<td class="gm-right" data-label="' + t('col_score_prep') + '"><input type="text" inputmode="numeric" class="hist-edit-num gm-score-input" data-field="score_prep" data-pseudo="' + escapeHTML(r.pseudo) + '" aria-label="' + escapeHTML(t('col_score_prep') + ', ' + r.pseudo) + '" value="' + (r.score_prep != null ? formatNumber(r.score_prep) : '') + '"></td>' +
            '<td class="gm-right" data-label="' + t('col_score_pvp') + '"><input type="text" inputmode="numeric" class="hist-edit-num gm-score-input" data-field="score_pvp" data-pseudo="' + escapeHTML(r.pseudo) + '" aria-label="' + escapeHTML(t('col_score_pvp') + ', ' + r.pseudo) + '" value="' + (r.score_pvp != null ? formatNumber(r.score_pvp) : '') + '"></td>';
        } else if (meta.hasScore) {
          scoreCells = '<td class="gm-right" data-label="' + t('col_score') + '"><input type="text" inputmode="numeric" class="hist-edit-num gm-score-input" data-field="score" data-pseudo="' + escapeHTML(r.pseudo) + '" aria-label="' + escapeHTML(t('col_score') + ', ' + r.pseudo) + '" value="' + (r.score != null ? formatNumber(r.score) : '') + '"></td>';
        }
      } else {
        if (isDualScore) {
          scoreCells = '<td class="gm-right" data-label="' + t('col_score_prep') + '">' + (r.score_prep != null ? formatNumber(r.score_prep) : '-') + '</td>' +
            '<td class="gm-right" data-label="' + t('col_score_pvp') + '">' + (r.score_pvp != null ? formatNumber(r.score_pvp) : '-') + '</td>';
        } else if (meta.hasScore) {
          scoreCells = '<td class="gm-right" data-label="' + t('col_score') + '">' + (r.score != null ? formatNumber(r.score) : '-') + '</td>';
        }
      }

      return '<tr>' +
        '<td><div class="gm-row" style="gap:.5rem;"><div class="gm-avatar">' + escapeHTML(initial) + '</div><strong>' + escapeHTML(r.pseudo) + '</strong></div></td>' +
        participatedCell + lateCell + excusedCell + subPresentCell + appointedCell + scoreCells +
        '</tr>';
    }).join('');

    const totalScore = sorted.reduce((s, r) => s + (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0), 0);
    const doneCount = sorted.reduce((s, r) => s + (r.participated > 0 ? 1 : 0), 0);

    const deleteBtnHtml =
      '<button class="gm-btn gm-btn-danger" id="history-modal-delete" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);"><i class="ph ph-trash"></i> <span>' + t('delete_title') + '</span></button>';

    const overlay = openDialog({
      id: 'history-modal',
      title: meta.label,
      iconClass: meta.icon,
      subtitle: escapeHTML(when) + ' · ' + escapeHTML(formatWeek(weekStart)),
      size: 'lg',
      scrollBody: true,
      body:
        '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; margin-bottom:1rem;">' +
          '<span class="gm-chip"><i class="ph ph-users"></i> ' + sorted.length + '</span>' +
          '<span class="gm-chip gm-chip-success"><i class="ph ph-check-circle"></i> ' + doneCount + ' ' + t('event_participated') + '</span>' +
          (totalScore > 0 ? '<span class="gm-chip gm-chip-accent"><i class="ph ph-trophy"></i> ' + formatNumber(totalScore) + '</span>' : '') +
        '</div>' +
        (sorted.length === 0
          ? '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('history_empty_session') + '</div></div>'
          : '<div class="gm-table-wrap gm-ui-table-wrap"><div class="gm-table-scroll">' +
              '<table class="gm-table gm-resp-table gm-ui-table-el gm-ui-table-sticky">' +
                '<thead><tr>' + headerCols + '</tr></thead>' +
                '<tbody>' + rowsHtml + '</tbody>' +
              '</table>' +
            '</div></div>'),
      footer:
        // gm-modal-footer contract: destructive delete sits in the dialog
        // footer-left, close action on the right, never next to the header X.
        '<div id="history-modal-footer-left">' + (isAdmin ? deleteBtnHtml : '') + '</div>' +
        '<div style="display:flex; gap:0.5rem; align-items:center;">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="history-modal-footer-close" data-dialog-close>' + t('close_title') + '</button>' +
        '</div>',
      confirmLabel: undefined,
      onConfirm: () => { /* Dialog closes itself after a resolved onConfirm. */ }
    });

    if (isAdmin) {
      overlay.querySelectorAll('.hist-edit-check').forEach((el) => {
        const cb = el as HTMLInputElement;
        cb.addEventListener('change', () => {
          const pseudo = cb.getAttribute('data-pseudo') || '';
          const field = cb.getAttribute('data-field') || '';
          const val = field === 'participated' ? (cb.checked ? 1 : 0) : cb.checked;
          void this.updateParticipantField(eventName, sessionId, weekStart, pseudo, field, val);
        });
      });
      overlay.querySelectorAll('.hist-edit-num:not(.hist-day-input)').forEach((el) => {
        const input = el as HTMLInputElement;
        attachNumberFormatter(input);
        input.addEventListener('change', () => {
          const pseudo = input.getAttribute('data-pseudo') || '';
          const field = input.getAttribute('data-field') || '';
          const val = Number(parseNumber(input.value) || 0);
          void this.updateParticipantField(eventName, sessionId, weekStart, pseudo, field, val);
          if (val > 0) {
            const row = input.closest('tr');
            if (row) {
              const cb = row.querySelector('.hist-edit-check[data-field="participated"]') as HTMLInputElement | null;
              if (cb && !cb.checked) {
                cb.checked = true;
                void this.updateParticipantField(eventName, sessionId, weekStart, pseudo, 'participated', 1);
              }
            }
          }
        });
      });
      overlay.querySelectorAll('.hist-day-input').forEach((el) => {
        const input = el as HTMLInputElement;
        attachNumberFormatter(input);
        input.addEventListener('change', () => {
          const pseudo = input.getAttribute('data-pseudo') || '';
          const day = Number(input.getAttribute('data-day'));
          const val = Number(parseNumber(input.value) || 0);
          if (sessionId) void this.updateGranularDayField(eventName, sessionId, pseudo, day, val);
          if (val > 0) {
            const row = input.closest('tr');
            if (row) {
              const cb = row.querySelector('.hist-edit-check[data-field="participated"]') as HTMLInputElement | null;
              if (cb && !cb.checked) {
                cb.checked = true;
                void this.updateParticipantField(eventName, sessionId, weekStart, pseudo, 'participated', 1);
              }
            }
          }
        });
      });
    }

    const close = (): void => closeDialog(overlay);

    const deleteBtn = document.getElementById('history-modal-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        showConfirm(
          t('confirm_delete_session_title'),
          '<strong>' + escapeHTML(meta.label) + '</strong><br>' + t('confirm_delete_session_body'),
          async () => {
            try {
              // Participants, Shadowfront squads and status, in one transaction (M4a).
              await deleteHistorySession(eventName, weekStart, sessionId || null);

              showToast(t('toast_session_deleted'), 'success');
              close();
              await this.load();
            } catch (err: any) {
              console.error('Delete history session error', err);
              showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            }
          }
        );
      });
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_HISTORY` at cutover). */
export const historyView = new HistoryView();

export default historyView;
