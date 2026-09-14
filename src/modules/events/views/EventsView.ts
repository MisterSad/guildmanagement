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
  type WarEventName,
  type OpponentCandidate
} from '../events.service';
import type { WarSession, ChestTier } from '../../../types/database';
import { resolveChestsForScore, resolvePrepChests, prepTotal, aggregateTierSlice, defaultChestGrid, WAR_AGGREGATE_DAY, PREP_DAYS } from '../../../core/scoring/chests';
import { renderBadge, renderWarStatusBadge } from '../../../components/ui/Badge';
import { formatCompactNumber, formatNumber } from '../../../core/utils/numbers';
import { openDialog } from '../../../components/ui/Dialog';
import { getGuildConfig, setGuildConfig } from '../../../core/config/guild-config';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

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
    const g = gm();
    if (g && typeof g.escapeHTML === 'function') return g.escapeHTML(value);
    return value === null || value === undefined ? '' : String(value);
  },
  fmt(num: unknown): string {
    const g = gm();
    return g && typeof g.formatNumber === 'function' ? g.formatNumber(num) : String(num ?? '');
  },
  getActiveGuild(): string {
    const g = gm();
    return g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : 'ALPHA';
  },
  getWeekStart(dateArg?: unknown): string {
    const g = gm();
    if (!g || typeof g.getWeekStart !== 'function') return '';
    return dateArg === undefined ? g.getWeekStart() : g.getWeekStart(dateArg);
  },
  buildEventSessionId(eventName: string, when: unknown, existingIds?: unknown): string {
    const g = gm();
    return g && typeof g.buildEventSessionId === 'function' ? g.buildEventSessionId(eventName, when, existingIds as any) : '';
  },
  parseNumber(value: unknown): number {
    const g = gm();
    return g && typeof g.parseNumber === 'function' ? g.parseNumber(value) : (parseInt(String(value).replace(/[^0-9]/g, ''), 10) || 0);
  },
  attachNumberFormatter(input: unknown): void {
    const g = gm();
    if (g && typeof g.attachNumberFormatter === 'function') g.attachNumberFormatter(input);
  },
  avatarInit(value: unknown): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  formatDateTimeUTC(value: unknown): string {
    const g = gm();
    return g && typeof g.formatDateTimeUTC === 'function' ? g.formatDateTimeUTC(value) : String(value ?? '');
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  notifyDiscordEvent(eventName: string, when: unknown, kind: string): void {
    const g = gm();
    if (g && typeof g.notifyDiscordEvent === 'function') g.notifyDiscordEvent(eventName, when, kind);
  },
  pickEventStart(opts: unknown, cb: (startAt: string | null) => void): void {
    const g = gm();
    if (g && typeof g.pickEventStart === 'function') g.pickEventStart(opts, cb);
  },
  runInChunks(items: string[], size: number, worker: (item: string) => Promise<void>): Promise<void> {
    const g = gm();
    if (g && typeof g.runInChunks === 'function') return g.runInChunks(items, size, worker);
    return (async () => { for (const it of items) await worker(it); })();
  },
  showConfirm(title: string, body: string, onConfirm: () => void): void {
    const w = winAny();
    if (typeof w.showConfirm === 'function') w.showConfirm(title, body, onConfirm);
  }
};

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

  private currentGuild(): string {
    return this.guildOverride || legacy.getActiveGuild();
  }

  // ── Load event (called when a tab is clicked) ─────────────────────────────
  public async loadEvent(tabKey: string, customGuildId?: string): Promise<void> {
    if (customGuildId) this.guildOverride = customGuildId;
    const db = legacy.getDb();
    if (!db || !TAB_TO_DB_EVENTS[tabKey]) return;
    try {
      const dbEvents = TAB_TO_DB_EVENTS[tabKey];
      const currentG = this.currentGuild();
      let query: any = db.from('event_status').select('event_name, is_active, session_id, stage, start_at').in('event_name', dbEvents);
      query = query.eq('guild', currentG);
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
    const db = legacy.getDb();
    if (!db) return;
    const currentG = this.currentGuild();
    const ref = startAt || new Date();
    // Fetch existing session_ids for this guild+event to resolve same-day collisions.
    const existingRes = await db.from('event_participants').select('session_id').eq('guild', currentG).eq('event_name', dbEventName);
    const existingIds = ((existingRes.data || []) as any[]).map((r) => r.session_id);
    const sessionId = legacy.buildEventSessionId(dbEventName, ref, existingIds);
    try {
      const statusRes = await db.from('event_status').upsert(
        {
          guild: currentG,
          event_name: dbEventName,
          is_active: true,
          session_id: sessionId,
          stage: stage || null,
          start_at: startAt || null,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'guild,event_name' }
      );
      if (statusRes.error) throw statusRes.error;
      legacy.showToast(legacy.t('event_session_started'), 'success');
      legacy.notifyDiscordEvent(dbEventName, startAt || sessionId, 'start');
    } catch (err: any) {
      console.error('startEvent', err);
      legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
    }
    await this.loadEvent(tabKey);
  }

  // ── End current session ───────────────────────────────────────────────────
  private async endEvent(tabKey: string): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName) return;
    const currentG = this.currentGuild();
    try {
      const statusRes = await db.from('event_status').upsert(
        {
          guild: currentG,
          event_name: s.activeEventName,
          is_active: false,
          session_id: s.sessionId,
          stage: s.stage,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'guild,event_name' }
      );
      if (statusRes.error) throw statusRes.error;
      s.activeEventName = null;
      s.sessionId = null;
      s.stage = null;
      s.isActive = false;
      this.renderStatus(tabKey);
      this.renderInactive(tabKey);
      legacy.showToast(legacy.t('event_session_ended'), 'success');
    } catch (err: any) {
      console.error('endEvent', err);
      legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  // ── Auto-populate members for a new session (SECURITY DEFINER RPC) ────────
  private async populateParticipants(tabKey: string): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    const week = legacy.getWeekStart(s.startAt);
    const currentG = this.currentGuild();
    const rpcRes = await db.rpc('gm_populate_event_participants', {
      p_event_name: s.activeEventName,
      p_session_id: s.sessionId,
      p_week_start: week,
      p_guild: currentG
    });

    if (rpcRes.error) {
      console.error('populateParticipants: rpc error', rpcRes.error);
      legacy.showToast(legacy.t('toast_err_import_participants') + ' ' + rpcRes.error.message, 'error');
      return;
    }

    const inserted = (typeof rpcRes.data === 'number') ? rpcRes.data : 0;
    if (inserted > 0) legacy.showToast(inserted + ' ' + legacy.t('toast_members_imported'), 'success');
    await this.fetchParticipants(tabKey);
  }

  // ── In-memory sync of a newly added member ────────────────────────────────
  public async addMemberToActiveEvents(pseudo: string): Promise<number> {
    const db = legacy.getDb();
    if (!db || !pseudo) return 0;

    const dbEventNames: string[] = [];
    Object.keys(TAB_TO_DB_EVENTS).forEach((k) => { TAB_TO_DB_EVENTS[k].forEach((n) => dbEventNames.push(n)); });

    try {
      const currentG = this.currentGuild();
      const statusRes = await db.from('event_status')
        .select('event_name, session_id, start_at')
        .eq('guild', currentG)
        .eq('is_active', true)
        .in('event_name', dbEventNames);
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
          week_start: legacy.getWeekStart(matched.start_at || new Date()),
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
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    const currentG = this.currentGuild();
    const week = legacy.getWeekStart(s.startAt);

    // Auto-sync missing/transferred guild members before fetching.
    try {
      await db.rpc('gm_populate_event_participants', {
        p_event_name: s.activeEventName,
        p_session_id: s.sessionId,
        p_week_start: week,
        p_guild: currentG
      });
    } catch (_) { /* best-effort sync */ }

    const [partRes, memRes] = await Promise.all([
      db.from('event_participants').select('*')
        .eq('guild', currentG)
        .eq('event_name', s.activeEventName)
        .eq('session_id', s.sessionId)
        .order('pseudo', { ascending: true }),
      db.from('guild_members').select('pseudo, uid').eq('guild', currentG)
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
    const res = await EventsService.upsertWarSession({
      guild: this.currentGuild(),
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
      const result = war.session ? (war.session as any)['day' + d + '_result'] || null : null;
      const statusBadge = renderWarStatusBadge(
        result === 'won' ? 'W' : result === 'lost' ? 'L' : 'pending',
        { won: legacy.t('war_day_won'), lost: legacy.t('war_day_lost'), pending: legacy.t('war_day_pending') }
      );
      const cls = result === 'won' ? 'war-day-won' : result === 'lost' ? 'war-day-lost' : '';
      return '<button type="button" class="war-day-toggle ' + cls + '" data-day="' + d + '" title="Day ' + d + '">' +
        '<span class="war-day-num">D' + d + '</span>' +
        '<span class="war-day-state">' + statusBadge + '</span>' +
      '</button>';
    }).join('');

    const options = war.opponents.map((o) =>
      '<option value="' + legacy.esc(o.name) + '"></option>'
    ).join('');

    const mode = this.warMode(tabKey);
    const modeSwitch =
      '<div class="gm-row war-mode-switch" role="group" aria-label="' + legacy.esc(legacy.t('war_mode_detailed')) + '/' + legacy.esc(legacy.t('war_mode_aggregate')) + '" style="gap:.5rem; flex-wrap:wrap; align-items:center; justify-content:flex-end;">' +
        '<span class="gm-chip" style="white-space:nowrap;">' + legacy.t('war_day_total_prep') + '</span>' +
        '<button type="button" class="war-mode-btn gm-btn gm-btn-sm' + (mode === 'detailed' ? ' gm-active' : '') + '" data-war-mode="detailed" style="padding:0.3rem 0.6rem;"><i class="ph ph-list-numbers"></i> ' + legacy.esc(legacy.t('war_mode_detailed')) + '</button>' +
        '<button type="button" class="war-mode-btn gm-btn gm-btn-sm' + (mode === 'aggregate' ? ' gm-active' : '') + '" data-war-mode="aggregate" style="padding:0.3rem 0.6rem;"><i class="ph ph-plus-minus"></i> ' + legacy.esc(legacy.t('war_mode_aggregate')) + '</button>' +
      '</div>';

    host.innerHTML =
      '<div class="gm-card gm-card-padded" style="margin-bottom:1rem;">' +
        '<div class="gm-row" style="gap:1rem; flex-wrap:wrap; align-items:center; justify-content:space-between;">' +
          '<div class="gm-row" style="gap:.5rem; align-items:center; flex:1 1 260px; min-width:220px;">' +
            '<span class="gm-chip" style="white-space:nowrap;">' + legacy.t('war_opponent_label') + '</span>' +
            '<input type="text" class="gm-input war-opponent-input" list="' + datalistId + '" placeholder="' +
              legacy.esc(isSvs ? legacy.t('war_opponent_placeholder_svs') : legacy.t('war_opponent_placeholder_gvg')) + '" value="' + legacy.esc(current) + '">' +
            '<datalist id="' + datalistId + '">' + options + '</datalist>' +
          '</div>' +
          '<div class="gm-row war-day-results" style="gap:.45rem; flex-wrap:wrap;" data-event="' + legacy.esc(s.activeEventName || '') + '">' + dayChips + '</div>' +
        '</div>' +
        '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; align-items:center; justify-content:space-between; margin-top:.6rem;">' +
          '<span class="gm-dim" style="font-size:var(--fs-2xs);">' + legacy.esc(legacy.t(mode === 'aggregate' ? 'war_col_total_d15' : 'war_ocr_granular_hint')) + '</span>' +
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
    const res = await EventsService.upsertWarSession({
      guild: this.currentGuild(),
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
      legacy.showToast(legacy.t('war_opponent_save_error'), 'error');
      this.renderWarBanner(tabKey);
    }
  }

  private cycleWarDay(tabKey: string, btn: HTMLElement): void {
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;
    const day = Number(btn.getAttribute('data-day'));
    if (!(day >= 1 && day <= 6)) return;
    const war = this.getWar(tabKey);
    const key = 'day' + day + '_result';
    const prev = war.session ? (war.session as any)[key] || null : null;
    const next: 'won' | 'lost' | null = prev === 'won' ? 'lost' : prev === 'lost' ? null : 'won';
    if (war.session) (war.session as any)[key] = next;

    btn.classList.remove('war-day-won', 'war-day-lost');
    if (next === 'won') btn.classList.add('war-day-won');
    if (next === 'lost') btn.classList.add('war-day-lost');
    const stateSpan = btn.querySelector('.war-day-state');
    if (stateSpan) {
      stateSpan.innerHTML = renderWarStatusBadge(
        next === 'won' ? 'W' : next === 'lost' ? 'L' : 'pending',
        { won: legacy.t('war_day_won'), lost: legacy.t('war_day_lost'), pending: legacy.t('war_day_pending') }
      );
    }

    void EventsService.upsertWarSession({
      guild: this.currentGuild(),
      eventName: s.activeEventName as WarEventName,
      sessionId: s.sessionId,
      dailyResults: { ['day' + day]: next }
    }).then((res) => {
      if (res.ok && res.session) war.session = res.session;
      else this.renderWarBanner(tabKey);
    });
  }

  private wireGranularInputs(el: Element, tabKey: string): void {
    el.querySelectorAll('.day-score-input').forEach((node) => {
      const inp = node as HTMLInputElement;
      legacy.attachNumberFormatter(inp);
      const pseudo = inp.getAttribute('data-pseudo') || '';
      inp.addEventListener('input', () => {
        const row = inp.closest('.participant-row');
        if (row) this.updateChestCell(row, tabKey);
        const timerKey = tabKey + '::' + pseudo;
        if (this.warSaveTimers[timerKey]) clearTimeout(this.warSaveTimers[timerKey]);
        this.warSaveTimers[timerKey] = setTimeout(() => {
          void this.saveGranularRow(tabKey, pseudo, row);
        }, 700);
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
      const agg = aggInp ? legacy.parseNumber(aggInp.value) : 0;
      const d6 = d6Inp ? legacy.parseNumber(d6Inp.value) : 0;
      total = resolvePrepChests(grid, null, agg) +
        resolveChestsForScore(grid.filter((g) => g.day === 6), d6);
    } else {
      for (let d = 1; d <= 6; d++) {
        const inp = row.querySelector<HTMLInputElement>('.day-score-input[data-day="' + d + '"]');
        const score = inp ? legacy.parseNumber(inp.value) : 0;
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
        title: legacy.t('war_confirm_total_replaces_days'),
        iconClass: 'ph-warning',
        tone: 'danger',
        subtitle: legacy.esc(pseudo),
        body: '<strong>' + legacy.esc(pseudo) + '</strong><br>' + legacy.esc(legacy.t('war_col_total_d15')),
        confirmLabel: legacy.t('confirm_ok'),
        cancelLabel: legacy.t('confirm_cancel'),
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

    const rows: Array<{ pseudo: string; day: number; score: number }> = [];
    inputs.forEach((inp) => {
      if (inp.getAttribute('data-pseudo') !== pseudo) return;
      const day = Number(inp.getAttribute('data-day'));
      if (!(day >= 0 && day <= 6)) return;
      rows.push({ pseudo, day, score: legacy.parseNumber(inp.value) });
    });
    if (rows.length === 0) return;

    const war = this.getWar(tabKey);
    const existing = war.daily[pseudo] || [];
    const prevHasDaily = existing.some((e) => PREP_DAYS.indexOf(e.day) !== -1 && (Number(e.score) || 0) > 0);
    const prevHasAgg = existing.some((e) => e.day === WAR_AGGREGATE_DAY);
    const wroteAgg = rows.some((r) => r.day === WAR_AGGREGATE_DAY);
    const wroteDaily = rows.some((r) => PREP_DAYS.indexOf(r.day) !== -1);

    // Destructive conversion (aggregate on top of existing D1..D5): the RPC
    // clears the player's per-day scores, so require an explicit confirmation.
    if (wroteAgg && prevHasDaily) {
      const confirmed = await this.confirmAggregateConversion(tabKey, pseudo);
      if (!confirmed) {
        this.revertRowInputs(tabKey, row, pseudo);
        return;
      }
    }

    const res = await EventsService.upsertDailyScores(
      this.currentGuild(),
      s.activeEventName as WarEventName,
      s.sessionId,
      rows
    );
    if (!res.ok) return;

    war.daily[pseudo] = rows.map((r) => ({
      day: r.day,
      score: r.score,
      chests_unlocked: r.day === WAR_AGGREGATE_DAY
        ? resolveChestsForScore(aggregateTierSlice(war.grid), r.score)
        : resolveChestsForScore(war.grid.filter((g) => g.day === r.day), r.score)
    }));

    if (wroteAgg && prevHasDaily) {
      legacy.showToast(legacy.t('war_toast_total_replaced_days'), 'success');
    } else if (wroteDaily && prevHasAgg) {
      legacy.showToast(legacy.t('war_toast_days_replaced_total'), 'info');
    }

    const contentEl = this.getContentEl(tabKey);
    if (row) this.updateChestCell(row, tabKey);
    if (contentEl) this.refreshStats(contentEl, tabKey);
  }

  // ── Save participation / score ────────────────────────────────────────────
  private async saveParticipation(tabKey: string, pseudo: string, value: number): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    const currentG = this.currentGuild();
    await db.from('event_participants').update({ participated: value })
      .eq('guild', currentG)
      .eq('event_name', s.activeEventName)
      .eq('session_id', s.sessionId)
      .eq('pseudo', pseudo);
  }

  private async saveAppointed(tabKey: string, pseudo: string, value: boolean): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    const currentG = this.currentGuild();
    await db.from('event_participants').update({ appointed: value })
      .eq('guild', currentG)
      .eq('event_name', s.activeEventName)
      .eq('session_id', s.sessionId)
      .eq('pseudo', pseudo);
  }

  private async saveScoreField(tabKey: string, pseudo: string, field: string, value: unknown): Promise<void> {
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    const currentG = this.currentGuild();
    const num = legacy.parseNumber(value);
    const update: Record<string, unknown> = {};
    update[field] = num;
    await db.from('event_participants').update(update)
      .eq('guild', currentG)
      .eq('event_name', s.activeEventName)
      .eq('session_id', s.sessionId)
      .eq('pseudo', pseudo);
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
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    const currentG = this.currentGuild();
    try {
      const res = await db.from('event_status').select('start_at')
        .eq('guild', currentG)
        .eq('event_name', s.activeEventName).maybeSingle();
      if (res.error) throw res.error;

      const currentStartAt = res.data ? res.data.start_at : null;

      legacy.pickEventStart({
        eventLabel: s.activeEventName + ' - ' + legacy.t('edit_title'),
        defaultVal: currentStartAt
      }, async (startAt: string | null) => {
        if (!startAt) return;
        try {
          const updateRes = await db.from('event_status').update({
            start_at: startAt,
            updated_at: new Date().toISOString()
          }).eq('guild', currentG).eq('event_name', s.activeEventName);
          if (updateRes.error) throw updateRes.error;

          const newWeek = legacy.getWeekStart(startAt);
          const updatePartRes = await db.from('event_participants').update({ week_start: newWeek })
            .eq('guild', currentG)
            .eq('event_name', s.activeEventName)
            .eq('session_id', s.sessionId);
          if (updatePartRes.error) throw updatePartRes.error;

          const newSessionId = legacy.buildEventSessionId(s.activeEventName as string, new Date(startAt), []);
          if (newSessionId !== s.sessionId) {
            const updateSidPartRes = await db.from('event_participants').update({ session_id: newSessionId })
              .eq('guild', currentG)
              .eq('event_name', s.activeEventName)
              .eq('session_id', s.sessionId);
            if (updateSidPartRes.error) throw updateSidPartRes.error;

            const updateSidStatusRes = await db.from('event_status').update({ session_id: newSessionId })
              .eq('guild', currentG)
              .eq('event_name', s.activeEventName);
            if (updateSidStatusRes.error) throw updateSidStatusRes.error;

            s.sessionId = newSessionId;
          }

          legacy.showToast(legacy.t('toast_member_updated'), 'success');
          legacy.notifyDiscordEvent(s.activeEventName as string, startAt, 'edit');
          await this.loadEvent(tabKey);
        } catch (err: any) {
          console.error('editEventSchedule update', err);
          legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
        }
      });
    } catch (err: any) {
      console.error('editEventSchedule fetch', err);
      legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private deleteEventSession(tabKey: string): void {
    const db = legacy.getDb();
    if (!db) return;
    const s = this.state[tabKey];
    if (!s.activeEventName || !s.sessionId) return;

    legacy.showConfirm(
      legacy.t('confirm_delete_session_title'),
      '<strong>' + legacy.esc(s.activeEventName) + '</strong><br>' + legacy.t('confirm_delete_session_body'),
      async () => {
        try {
          const currentG = this.currentGuild();
          const delPartRes = await db.from('event_participants').delete()
            .eq('guild', currentG)
            .eq('event_name', s.activeEventName)
            .eq('session_id', s.sessionId);
          if (delPartRes.error) throw delPartRes.error;

          const delStatusRes = await db.from('event_status').delete()
            .eq('guild', currentG)
            .eq('event_name', s.activeEventName);
          if (delStatusRes.error) throw delStatusRes.error;

          legacy.showToast(legacy.t('toast_session_deleted'), 'success');
          s.activeEventName = null;
          s.sessionId = null;
          s.stage = null;
          s.isActive = false;
          this.renderStatus(tabKey);
          this.renderInactive(tabKey);
        } catch (err: any) {
          console.error('deleteEventSession', err);
          legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
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
      badge.innerHTML = '<span class="gm-dot"></span> ' + (s.isActive ? legacy.t('event_active') : legacy.t('event_inactive'));
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
      dimSpan.textContent = (s.isActive && s.startAt) ? ' · ' + legacy.formatDateTimeUTC(s.startAt) : '';
    }

    if (actionsDiv) {
      const eventNameAttr = tabKey;
      if (s.isActive) {
        actionsDiv.innerHTML =
          '<button class="gm-btn gm-btn-danger event-end-btn" data-event="' + legacy.esc(eventNameAttr) + '" style="margin-right: 0.25rem;"><i class="ph ph-stop-circle"></i> <span>' + legacy.t('event_end') + '</span></button>' +
          '<button class="gm-btn event-edit-sched-btn" style="background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; margin-right: 0.25rem;" data-event="' + legacy.esc(eventNameAttr) + '" title="' + legacy.t('edit_title') + '"><i class="ph ph-calendar"></i> <span>' + legacy.t('edit_title') + '</span></button>' +
          '<button class="gm-btn event-delete-session-btn" style="background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: var(--error);" data-event="' + legacy.esc(eventNameAttr) + '" title="' + legacy.t('delete_title') + '"><i class="ph ph-trash"></i></button>';

        const endBtnDyn = actionsDiv.querySelector('.event-end-btn');
        if (endBtnDyn) endBtnDyn.addEventListener('click', () => { void this.endEvent(tabKey); });
        const editBtnDyn = actionsDiv.querySelector('.event-edit-sched-btn');
        if (editBtnDyn) editBtnDyn.addEventListener('click', () => { void this.editEventSchedule(tabKey); });
        const deleteBtnDyn = actionsDiv.querySelector('.event-delete-session-btn');
        if (deleteBtnDyn) deleteBtnDyn.addEventListener('click', () => { this.deleteEventSession(tabKey); });
      } else {
        actionsDiv.innerHTML =
          '<button class="gm-btn gm-btn-success event-start-btn" data-event="' + legacy.esc(eventNameAttr) + '" style="margin-right: 0.25rem;"><i class="ph ph-play"></i> <span>' + legacy.t('event_start') + '</span></button>' +
          '<button class="gm-btn gm-btn-danger event-end-btn" data-event="' + legacy.esc(eventNameAttr) + '" disabled><i class="ph ph-stop-circle"></i> <span>' + legacy.t('event_end') + '</span></button>';

        const startBtnDyn = actionsDiv.querySelector('.event-start-btn');
        if (startBtnDyn) {
          startBtnDyn.addEventListener('click', () => {
            if (SCHEDULED_TABS.indexOf(tabKey) !== -1) {
              legacy.pickEventStart({ eventLabel: tabKey }, (startAt: string | null) => {
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
        '<i class="ph-duotone ph-rocket-launch gm-icon"></i>' +
        '<div class="gm-empty-title">' + legacy.t('event_not_active') + '</div>' +
        '<div class="gm-empty-hint">' + legacy.t('event_not_active_hint') + '</div>' +
      '</div>';
  }

  private renderParticipants(tabKey: string): void {
    const el = this.getContentEl(tabKey);
    if (!el) return;
    const s = this.state[tabKey];
    const participants = s.participants;
    const dbEventName = s.activeEventName;

    if (!participants.length) {
      el.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + legacy.t('empty_members') + '</div></div>';
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
          '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + participants.length + ' ' + legacy.t('event_total') + '</span>' +
          '<span class="gm-chip gm-chip-success"><i class="ph-fill ph-check-circle"></i> ' + done + ' ' + legacy.t('event_participated') + '</span>' +
          '<span class="gm-chip"><i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + legacy.t('event_absent') + '</span>' +
          (isDtr ? '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-check-square"></i> ' + appointedCount + ' Appointed</span>' : '') +
          (hasScore ? '<span class="gm-chip gm-chip-accent" title="' + legacy.esc(formatNumber(totalScore)) + '"><i class="ph-fill ph-trophy"></i> ' + legacy.t('event_total_score') + ' ' + formatCompactNumber(totalScore) + '</span>' : '') +
          approveAllBtn +
        '</div>' +
        '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
          '<i class="ph ph-magnifying-glass gm-icon"></i>' +
          '<input type="text" class="gm-input event-search-input" placeholder="' + legacy.t('search_placeholder') + '">' +
          '<button type="button" class="gm-search-clear-btn" data-gm-search-clear aria-label="Clear search" tabindex="-1"><span class="material-symbols-rounded">cancel</span></button>' +
        '</div>' +
        '</div>' +
      '<div class="gm-table-wrap gm-ui-table-wrap"><div class="gm-table-scroll">' +
      '<table class="gm-table gm-resp-table gm-ui-table-el gm-ui-table-sticky">' +
        '<thead><tr>' +
          '<th>' + legacy.t('col_member') + '</th>' +
          '<th class="gm-center">' + legacy.t('col_participated') + '</th>' +
          (isDtr ? '<th class="gm-center">Appointed</th>' : '') +
          (granular
            ? (prepMode === 'aggregate'
                ? '<th class="gm-right">' + legacy.t('war_col_total_d15') + '</th><th class="gm-right">' + legacy.t('war_day_n').replace('{day}', '6') + '</th>'
                : [1, 2, 3, 4, 5, 6].map((d) =>
                    '<th class="gm-right">' + legacy.t('war_day_n').replace('{day}', String(d)) + '</th>'
                  ).join('')) +
              '<th class="gm-right">' + legacy.t('war_col_chests') + '</th>'
            : (isSvsOrGvg
              ? '<th class="gm-right">' + legacy.t('col_score_prep') + '</th><th class="gm-right">' + legacy.t('col_score_pvp') + '</th>'
              : (hasScore ? '<th class="gm-right">' + legacy.t('col_score') + '</th>' : ''))) +
          (pendingCount > 0 ? '<th class="gm-center">Actions</th>' : '') +
        '</tr></thead><tbody>';

    participants.forEach((p) => {
      const isChecked = p.participated > 0;
      const isAppointedChecked = !!p.appointed;
      const initial = legacy.avatarInit(p.pseudo);

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
          granularCells += '<td class="gm-right" data-label="' + legacy.t('war_col_total_d15') + '">' +
            '<input type="text" inputmode="numeric" class="gm-score-input day-score-input" data-pseudo="' + legacy.esc(p.pseudo) + '" data-day="0" value="' + (agg != null ? legacy.fmt(agg) : '') + '" placeholder="-">' +
          '</td>';
          granularCells += '<td class="gm-right" data-label="Day 6">' +
            '<input type="text" inputmode="numeric" class="gm-score-input day-score-input" data-pseudo="' + legacy.esc(p.pseudo) + '" data-day="6" value="' + (d6 != null ? legacy.fmt(d6) : '') + '" placeholder="-">' +
          '</td>';
          chestTotal = resolvePrepChests(grid, dayScores, agg) +
            resolveChestsForScore(grid.filter((g) => g.day === 6), d6);
        } else {
          for (let d = 1; d <= 6; d++) {
            const v = dayScores[d];
            granularCells += '<td class="gm-right" data-label="Day ' + d + '">' +
              '<input type="text" inputmode="numeric" class="gm-score-input day-score-input" data-pseudo="' + legacy.esc(p.pseudo) + '" data-day="' + d + '" value="' + (v != null ? legacy.fmt(v) : '') + '" placeholder="-">' +
            '</td>';
          }
          for (let d = 1; d <= 6; d++) {
            chestTotal += resolveChestsForScore(grid.filter((g) => g.day === d), dayScores[d]);
          }
        }
        granularCells += '<td class="gm-right player-chests-cell" title="' + legacy.esc(formatNumber(chestTotal || 0)) + '">' +
          (chestTotal
            ? renderBadge({ text: formatNumber(chestTotal), tone: 'glory', style: 'soft', size: 'sm', title: formatNumber(chestTotal) })
            : '-') +
        '</td>';
      }

      const rowClass = 'participant-row' + (isChecked ? ' participated' : '') + (p.is_pending ? ' pending-approval-row' : '');
      const rowStyle = p.is_pending ? 'background: rgba(245, 158, 11, 0.05); border-left: 3px solid var(--warning);' : '';

      const actionBtn = p.is_pending
        ? '<button type="button" class="gm-btn gm-btn-success approve-single-btn" data-pseudo="' + legacy.esc(p.pseudo) + '" style="font-size: var(--fs-sm); padding:0.2rem 0.4rem; display:inline-flex; align-items:center; gap:0.25rem;"><i class="ph ph-check"></i> Approve</button>'
        : '';

      html +=
        '<tr class="' + rowClass + '" style="' + rowStyle + '" data-pseudo="' + legacy.esc(p.pseudo) + '">' +
          '<td data-label="' + legacy.t('col_member') + '">' +
            '<div class="gm-row" style="gap:.6rem;">' +
              '<div class="gm-avatar">' + legacy.esc(initial) + '</div>' +
              '<strong style="display:inline-flex; align-items:center; gap:0.4rem;">' +
                legacy.esc(p.pseudo) +
                (p.is_pending ? '<span class="gm-chip" style="font-size: var(--fs-2xs); padding:0.05rem 0.25rem; background:rgba(245,158,11,0.1); color:var(--warning); border:1px solid rgba(245,158,11,0.25);">Pending</span>' : '') +
              '</strong>' +
            '</div>' +
          '</td>' +
          '<td class="gm-center" data-label="' + legacy.t('col_participated') + '">' +
            '<label class="check-toggle">' +
              '<input type="checkbox" class="participation-checkbox" data-pseudo="' + legacy.esc(p.pseudo) + '"' + (isChecked ? ' checked' : '') + '>' +
              '<span class="check-slider"></span>' +
            '</label>' +
          '</td>' +
          (isDtr
            ? '<td class="gm-center" data-label="Appointed">' +
                '<label class="check-toggle">' +
                  '<input type="checkbox" class="participation-checkbox appointed-checkbox" data-pseudo="' + legacy.esc(p.pseudo) + '"' + (isAppointedChecked ? ' checked' : '') + '>' +
                  '<span class="check-slider"></span>' +
                '</label>' +
              '</td>'
            : '') +
          (granular
            ? granularCells
            : (isSvsOrGvg
              ? '<td class="gm-right" data-label="' + legacy.t('col_score_prep') + '">' +
                  '<input type="text" inputmode="numeric" class="gm-score-input score-input-prep" value="' + (p.score_prep != null ? legacy.fmt(p.score_prep) : '') + '" placeholder="-" data-pseudo="' + legacy.esc(p.pseudo) + '">' +
                '</td>' +
                '<td class="gm-right" data-label="' + legacy.t('col_score_pvp') + '">' +
                  '<input type="text" inputmode="numeric" class="gm-score-input score-input-pvp" value="' + (p.score_pvp != null ? legacy.fmt(p.score_pvp) : '') + '" placeholder="-" data-pseudo="' + legacy.esc(p.pseudo) + '">' +
                '</td>'
              : (hasScore ? '<td class="gm-right" data-label="' + legacy.t('col_score') + '">' +
                  '<input type="text" inputmode="numeric" class="gm-score-input score-input" value="' + (p.score != null ? legacy.fmt(p.score) : '') + '" placeholder="-" data-pseudo="' + legacy.esc(p.pseudo) + '">' +
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
        legacy.attachNumberFormatter(inp);
        let timer: ReturnType<typeof setTimeout> | undefined;
        inp.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const pseudo = inp.getAttribute('data-pseudo') || '';
            void this.saveScoreField(tabKey, pseudo, field, inp.value).then(() => {
              const pp = this.state[tabKey].participants.find((x) => x.pseudo === pseudo);
              if (pp) pp[stateKey] = legacy.parseNumber(inp.value);
              this.refreshStats(el, tabKey);
            });
          }, 700);
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
          const db = legacy.getDb();
          const rpcRes = await db.rpc('gm_approve_participant_submission', {
            p_guild: this.currentGuild(),
            p_event_name: s.activeEventName,
            p_session_id: s.sessionId,
            p_pseudo: pseudo
          });
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
          legacy.showToast('Failed to approve submission.', 'error');
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
          await legacy.runInChunks(pendingPseudos, 10, async (pseudo: string) => {
            const db = legacy.getDb();
            const rpcRes = await db.rpc('gm_approve_participant_submission', {
              p_guild: activeGuildForApproval,
              p_event_name: s.activeEventName,
              p_session_id: s.sessionId,
              p_pseudo: pseudo
            });
            if (rpcRes.error) throw rpcRes.error;
          });
          this.state[tabKey].participants.forEach((p) => { if (p.is_pending) p.is_pending = false; });
          this.renderParticipants(tabKey);
          await this.fetchParticipants(tabKey);
        } catch (err) {
          console.error('approve all', err);
          legacy.showToast('Failed to approve all submissions.', 'error');
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
    if (chips[1]) chips[1].innerHTML = '<i class="ph-fill ph-check-circle"></i> ' + done + ' ' + legacy.t('event_participated');
    if (chips[2]) chips[2].innerHTML = '<i class="ph-fill ph-x-circle"></i> ' + (participants.length - done) + ' ' + legacy.t('event_absent');

    const isDtr = this.state[tabKey].activeEventName === 'Defend Trade Route';
    if (isDtr) {
      const appointedCount = participants.reduce((a, p) => a + (p.appointed ? 1 : 0), 0);
      if (chips[3]) chips[3].innerHTML = '<i class="ph-fill ph-check-square"></i> ' + appointedCount + ' Appointed';
    } else {
      const hasScore = EVENTS_WITHOUT_SCORE.indexOf(this.state[tabKey].activeEventName as string) === -1;
      if (hasScore && chips[3]) {
        chips[3].innerHTML = '<i class="ph-fill ph-trophy"></i> ' + legacy.t('event_total_score') + ' ' + legacy.fmt(totalScore);
      }
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_EVENTS` at cutover). */
export const eventsView = new EventsView();

export default eventsView;
