/**
 * src/modules/overview/views/OverviewView.ts
 *
 * Strangler Phase 1 port of the root `overview.js` (Command Center dashboard):
 * summary tiles, timezone clocks, recent activity, upcoming agenda, pending
 * registrations slot and Web Push opt-in.
 *
 * Tickers (countdown + timezone clocks) are tracked so `destroy()` clears them.
 * This module never assigns `window.GM_OVERVIEW` (bridge added at cutover).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  ClockMember,
  prettyEventName,
  fullEventName,
  pad2,
  formatCountdown,
  relativeTime,
  formatBigNumber,
  getDefaultClocks,
  parseTimezoneClocks,
  serializeTimezoneClocks,
  buildOfficerClocks
} from '../overview.service';
import { escapeHTML } from '../../../core/utils/text';
import {
  COMMON_TIMEZONES,
  formatOffsetLabel,
  formatTimeInZone,
  isValidTimezone,
  getTimezoneOffset
} from '../../../utils/timezone';

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
    return escapeHTML(value);
  },
  fmt(num: unknown): string {
    const g = gm();
    return g && typeof g.formatNumber === 'function' ? g.formatNumber(num) : String(num ?? '');
  },
  getActiveGuild(): string {
    const g = gm();
    return g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : 'ALPHA';
  },
  getWeekStart(): string {
    const g = gm();
    return g && typeof g.getWeekStart === 'function' ? g.getWeekStart() : '';
  },
  getPrevWeekStart(week: string): string {
    const g = gm();
    if (g && typeof g.getPrevWeekStart === 'function') return g.getPrevWeekStart(week);
    const d = new Date(week + 'T12:00:00Z');
    if (isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  },
  formatDateTimeUTC(value: unknown): string {
    const g = gm();
    return g && typeof g.formatDateTimeUTC === 'function' ? g.formatDateTimeUTC(value) : String(value ?? '');
  },
  getEventIcon(name: string): string {
    const g = gm();
    return g && typeof g.getEventIcon === 'function' ? g.getEventIcon(name) : '';
  },
  getEventTheme(name: string): string {
    const g = gm();
    return g && typeof g.getEventTheme === 'function' ? g.getEventTheme(name) : 'gm-task-card-dark';
  },
  avatarInit(value: unknown): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  configGet(key: string): any {
    const g = gm();
    return g && g.config && typeof g.config.get === 'function' ? g.config.get(key) : undefined;
  },
  configSet(key: string, value: string): Promise<any> {
    const g = gm();
    if (g && g.config && typeof g.config.set === 'function') return g.config.set(key, value);
    return Promise.resolve();
  },
  renderPendingRegistrations(): void {
    const g = gm();
    if (g && typeof g.renderPendingRegistrations === 'function') g.renderPendingRegistrations();
  },
  exportGuildData(guild: string): Promise<any> {
    const g = gm();
    if (g && typeof g.exportGuildData === 'function') return g.exportGuildData(guild);
    return Promise.reject(new Error('exportGuildData unavailable'));
  }
};

export class OverviewView {
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private timezoneClockTimer: ReturnType<typeof setInterval> | null = null;
  private clockMembers: ClockMember[] = [];

  public getState(): { clockMembers: ClockMember[] } {
    return { clockMembers: this.clockMembers };
  }

  public destroy(): void {
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    if (this.timezoneClockTimer) { clearInterval(this.timezoneClockTimer); this.timezoneClockTimer = null; }
  }

  public async load(): Promise<void> {
    const panel = document.getElementById('gm-overview');
    if (!panel) return;

    try {
      const clocksStr = await legacy.configGet('timezone_clocks');
      this.clockMembers = clocksStr ? parseTimezoneClocks(clocksStr) : getDefaultClocks();
    } catch (e) {
      console.error('Failed to load timezone clocks', e);
      this.clockMembers = getDefaultClocks();
    }

    this.renderShell(panel);

    const db = legacy.getDb();
    if (!db) return;

    try {
      const week = legacy.getWeekStart();
      const prevWeek = legacy.getPrevWeekStart(week);
      const currentG = legacy.getActiveGuild();

      let memCountQ = db.from('guild_members').select('id', { count: 'exact', head: true });
      let statusQ = db.from('event_status').select('event_name, is_active, updated_at, session_id, start_at');
      let gloryQ = db.from('event_participants').select('pseudo, score').eq('event_name', 'Glory').eq('week_start', week);
      let gloryPrevQ = db.from('event_participants').select('pseudo, score').eq('event_name', 'Glory').eq('week_start', prevWeek);
      let sanctionsQ = db.from('sanctions').select('id, pseudo, comment, created_by, created_at').order('created_at', { ascending: false }).limit(5);
      let recentMemQ = db.from('guild_members').select('pseudo, created_at').order('created_at', { ascending: false }).limit(5);
      const transfersQ = db.from('guild_transfers').select('pseudo, source_guild, target_guild, resolved_at').eq('status', 'approved').or('source_guild.eq.' + currentG + ',target_guild.eq.' + currentG).order('resolved_at', { ascending: false }).limit(5);
      let powerQ = db.from('guild_members').select('overall_power');
      let officersQ = db.from('guild_members').select('pseudo, role, timezone, timezone_offset');

      memCountQ = memCountQ.eq('guild', currentG);
      statusQ = statusQ.eq('guild', currentG);
      gloryQ = gloryQ.eq('guild', currentG);
      gloryPrevQ = gloryPrevQ.eq('guild', currentG);
      sanctionsQ = sanctionsQ.eq('guild', currentG);
      recentMemQ = recentMemQ.eq('guild', currentG);
      powerQ = powerQ.eq('guild', currentG);
      officersQ = officersQ.eq('guild', currentG);

      const [memCount, statusRows, gloryRows, gloryPrevRows, sanctionsRows, recentMembers, transfersRows, powerRows, officersRows] = await Promise.all([
        memCountQ, statusQ, gloryQ, gloryPrevQ, sanctionsQ, recentMemQ, transfersQ, powerQ, officersQ
      ]);

      if (this.clockMembers.length === 0 && officersRows && officersRows.data) {
        const officerClocks = buildOfficerClocks(officersRows.data);
        if (officerClocks.length > 0) {
          this.clockMembers = officerClocks;
          this.renderTimezoneClocks(panel);
        }
      }

      // Glory is cumulative per player: "this week" is the gain,
      // sum of (current week score - previous week score) per member.
      const prevByPseudo: Record<string, number> = {};
      ((gloryPrevRows.data || []) as any[]).forEach((r) => {
        if (r.score != null || prevByPseudo[r.pseudo] == null) prevByPseudo[r.pseudo] = r.score || 0;
      });
      const currByPseudo: Record<string, number> = {};
      ((gloryRows.data || []) as any[]).forEach((r) => {
        if (r.score != null || currByPseudo[r.pseudo] == null) currByPseudo[r.pseudo] = r.score || 0;
      });
      const gloryGained = Object.keys(currByPseudo).reduce((acc, pseudo) => {
        const gain = (currByPseudo[pseudo] || 0) - (prevByPseudo[pseudo] || 0);
        return acc + Math.max(0, gain);
      }, 0);

      const liveRows = ((statusRows.data || []) as any[]).filter((s) => s.is_active);
      const stats = {
        members: memCount.count || 0,
        liveEvents: liveRows.length,
        liveEventNames: liveRows.map((s) => prettyEventName(s.event_name)),
        gloryTotal: gloryGained,
        sanctions: ((sanctionsRows.data || []) as any[]).length,
        totalPower: ((powerRows.data || []) as any[]).reduce((a, m) => a + (parseInt(m.overall_power, 10) || 0), 0)
      };

      // Activity feed: merge events + sanctions + new members + transfers.
      let activity: Array<{ icon: string; color: string; text: string; when: string }> = [];
      ((statusRows.data || []) as any[]).forEach((s) => {
        if (!s.updated_at) return;
        activity.push({
          icon: s.is_active ? 'ph-play' : 'ph-stop-circle',
          color: s.is_active ? 'success' : 'info',
          text: prettyEventName(s.event_name) + ' ' + legacy.t(s.is_active ? 'overview_event_started' : 'overview_event_ended'),
          when: s.updated_at
        });
      });
      ((sanctionsRows.data || []) as any[]).forEach((s) => {
        activity.push({
          icon: 'ph-warning-octagon',
          color: 'danger',
          text: legacy.t('overview_sanction_for') + ' ' + s.pseudo + (s.created_by ? ' (' + s.created_by + ')' : ''),
          when: s.created_at
        });
      });
      ((recentMembers.data || []) as any[]).forEach((m) => {
        activity.push({ icon: 'ph-user-plus', color: 'success', text: m.pseudo + ' ' + legacy.t('overview_member_added'), when: m.created_at });
      });
      ((transfersRows.data || []) as any[]).forEach((t) => {
        const isIncoming = t.target_guild === currentG;
        const text = isIncoming ? t.pseudo + ' transferred from ' + t.source_guild : t.pseudo + ' transferred to ' + t.target_guild;
        activity.push({ icon: 'ph-swap', color: isIncoming ? 'success' : 'warning', text, when: t.resolved_at });
      });
      activity.sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());
      activity = activity.slice(0, 6);

      const nowMs = Date.now();
      const upcoming = ((statusRows.data || []) as any[])
        .filter((s) => s.start_at && new Date(s.start_at).getTime() > nowMs)
        .map((s) => ({ name: fullEventName(s.event_name), when: s.start_at }))
        .sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());

      this.renderPage(panel, stats, activity, upcoming);
    } catch (err: any) {
      console.error('overview load', err);
      legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  private renderShell(panel: HTMLElement): void {
    // Reset any previous tickers before re-rendering.
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    if (this.timezoneClockTimer) { clearInterval(this.timezoneClockTimer); this.timezoneClockTimer = null; }

    panel.innerHTML =
      '<div class="gm-page">' +
        '<header class="gm-page-header">' +
          '<div>' +
            '<h1 class="gm-page-title">' + legacy.t('gm_overview_title') + '</h1>' +
            '<p class="gm-page-subtitle">' + legacy.t('gm_overview_sub_real') + '</p>' +
          '</div>' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="gm-export-guild-data-btn">' +
            '<i class="ph ph-download-simple"></i> <span>' + legacy.t('overview_export_guild_data') + '</span>' +
          '</button>' +
        '</header>' +
        '<div class="gm-section-head" style="margin-bottom: 0.75rem; align-items: center;">' +
          '<h3 style="font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600; display: flex; align-items: center; gap: 0.5rem; margin: 0;"><i class="ph ph-clock"></i> Clocks</h3>' +
          '<button class="gm-mini-btn" id="gm-manage-clocks-btn"><i class="ph ph-gear"></i> ' + legacy.t('manage_clocks') + '</button>' +
        '</div>' +
        '<div class="gm-overview-clocks" id="gm-overview-clocks" style="margin-bottom: 2rem;"></div>' +
        '<div data-gm-overview-content></div>' +
      '</div>';

    this.renderTimezoneClocks(panel);
    this.startTimezoneClockTicker();

    const manageBtn = panel.querySelector('#gm-manage-clocks-btn');
    if (manageBtn) manageBtn.addEventListener('click', () => this.openManageClocksModal(panel));

    const exportBtn = panel.querySelector('#gm-export-guild-data-btn') as HTMLButtonElement | null;
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true;
        const icon = exportBtn.querySelector('i');
        if (icon) icon.className = 'ph ph-circle-notch ph-spin';
        try {
          const res = await legacy.exportGuildData(legacy.getActiveGuild());
          if (!res.ok) throw new Error(res.error || 'export_failed');
        } catch (err: any) {
          legacy.showToast(legacy.t('toast_err_generic') + ' ' + err.message, 'error');
        } finally {
          exportBtn.disabled = false;
          if (icon) icon.className = 'ph ph-download-simple';
        }
      });
    }
  }

  private renderTimezoneClocks(panel: ParentNode): void {
    const container = panel.querySelector('#gm-overview-clocks');
    if (!container) return;

    if (!this.clockMembers.length) {
      container.innerHTML =
        '<div class="gm-empty">' +
          '<i class="ph ph-clock gm-icon"></i>' +
          '<div class="gm-empty-title">No timezone clocks yet</div>' +
          '<div class="gm-empty-hint">Add an officer\'s timezone with "' + legacy.esc(legacy.t('manage_clocks')) + '" above.</div>' +
        '</div>';
      return;
    }

    let html = '';
    this.clockMembers.forEach((m) => {
      const initials = legacy.avatarInit(m.name);
      const offsetText = formatOffsetLabel(m.offset);
      const roleBadge = m.role ? ' <span style="font-size: var(--fs-xs); opacity: 0.8;">(' + legacy.esc(m.role) + ')</span>' : '';
      html +=
        '<div class="gm-clock-card" data-offset="' + m.offset + '" data-timezone="' + legacy.esc(m.timezone || '') + '">' +
          '<div class="gm-avatar gm-avatar-sm gm-avatar-' + m.color + '">' + legacy.esc(initials) + '</div>' +
          '<div class="gm-clock-info">' +
            '<div class="gm-clock-name">' + legacy.esc(m.name) + roleBadge + '</div>' +
            '<div class="gm-clock-meta">' +
              '<span>' + offsetText + '</span>' +
              '<span class="gm-clock-icon-slot"></span>' +
            '</div>' +
          '</div>' +
          '<div class="gm-clock-time">--:--:--</div>' +
        '</div>';
    });
    container.innerHTML = html;
    this.updateClocksTime();
  }

  private updateClocksTime(): void {
    const container = document.getElementById('gm-overview-clocks');
    if (!container) return;

    const cards = container.querySelectorAll('.gm-clock-card');
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);

    cards.forEach((card) => {
      const tz = card.getAttribute('data-timezone');
      const offset = parseFloat(card.getAttribute('data-offset') || '0');
      let timeStr: string;
      let hour: number;

      if (tz && isValidTimezone(tz)) {
        timeStr = formatTimeInZone(tz, now, true);
        const parts = timeStr.split(':');
        hour = parseInt(parts[0], 10) || 0;
      } else {
        const targetDate = new Date(utcMs + (3600000 * offset));
        timeStr = pad2(targetDate.getHours()) + ':' + pad2(targetDate.getMinutes()) + ':' + pad2(targetDate.getSeconds());
        hour = targetDate.getHours();
      }

      const timeEl = card.querySelector('.gm-clock-time');
      if (timeEl) timeEl.textContent = timeStr;

      const isDay = hour >= 6 && hour < 18;

      const iconSlot = card.querySelector('.gm-clock-icon-slot');
      if (iconSlot) {
        const iconClass = isDay ? 'ph-sun' : 'ph-moon';
        const currentIcon = iconSlot.querySelector('i');
        if (!currentIcon || !currentIcon.classList.contains(iconClass)) {
          iconSlot.innerHTML = '<i class="ph ' + iconClass + '" style="color: ' + (isDay ? '#fbbf24' : '#a5b4fc') + ';"></i>';
        }
      }
    });
  }

  private startTimezoneClockTicker(): void {
    if (this.timezoneClockTimer) { clearInterval(this.timezoneClockTimer); this.timezoneClockTimer = null; }
    const panel = document.getElementById('gm-overview');
    if (!panel || !panel.querySelector('#gm-overview-clocks')) return;
    this.timezoneClockTimer = setInterval(() => {
      if (document.hidden) return;
      const container = document.getElementById('gm-overview-clocks');
      if (!container) { if (this.timezoneClockTimer) clearInterval(this.timezoneClockTimer); this.timezoneClockTimer = null; return; }
      if (panel.classList.contains('active')) this.updateClocksTime();
    }, 1000);
  }

  private renderPage(panel: ParentNode, stats: any, activity: any[], upcoming: any[]): void {
    const content = panel.querySelector('[data-gm-overview-content]');
    if (!content) return;

    const liveEventsMeta = stats.liveEvents > 0 ? stats.liveEventNames.join(' · ') : legacy.t('overview_no_live');

    const html =
      '<div class="gm-stat-grid">' +
        this.statTile(legacy.t('overview_s_members'), legacy.fmt(stats.members), null, 'ph-users', false, 'Active Guild Members', 'stat-theme-lime') +
        this.statTile('Guild Power', formatBigNumber(stats.totalPower, (v) => legacy.fmt(v)), null, 'ph-gauge', false, 'Total Power of All Members', 'stat-theme-cyan') +
        this.statTile(legacy.t('overview_s_events'), String(stats.liveEvents), null, 'ph-clock', stats.liveEvents > 0, liveEventsMeta, 'stat-theme-coral') +
        this.statTile(legacy.t('overview_s_glory'), formatBigNumber(stats.gloryTotal, (v) => legacy.fmt(v)), 'up', 'ph-trophy', false, legacy.t('overview_s_glory_meta'), 'stat-theme-mint') +
      '</div>' +
      '<div class="gm-section" id="pending-accounts-card">' +
        '<div class="gm-section-head">' +
          '<div class="gm-section-title" style="color:var(--accent-amber); font-weight:700;">' +
            '<i class="ph ph-user-plus"></i>' +
            '<span>Pending Account Validations (Player Portal)</span>' +
            '<span class="gm-count" id="pending-account-count">0</span>' +
          '</div>' +
        '</div>' +
        '<div id="pending-account-list">' +
          '<div class="gm-empty" style="padding:1.25rem;">' +
            '<i class="ph ph-hourglass gm-icon"></i>' +
            '<div class="gm-empty-title">No pending registrations</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="gm-section">' +
        '<div class="gm-section-head">' +
          '<div class="gm-section-title"><i class="ph ph-calendar-dots"></i> ' + legacy.t('overview_upcoming_title') + '</div>' +
        '</div>' +
        this.renderUpcomingCard(upcoming) +
      '</div>' +
      '<div class="gm-section">' +
        '<div class="gm-section-head">' +
          '<div class="gm-section-title"><i class="ph ph-pulse"></i> ' + legacy.t('overview_recent_activity') + '</div>' +
        '</div>' +
        this.renderActivityCard(activity) +
      '</div>';

    content.innerHTML = html;

    legacy.renderPendingRegistrations();

    this.startCountdownTicker();
  }

  private getEventIcon(name: string): string {
    const fromGm = legacy.getEventIcon(name);
    if (fromGm) return fromGm;
    if (!name) return 'ph-calendar-dot';
    const lower = name.toLowerCase();
    if (lower.indexOf('svs') !== -1) return 'ph-sword';
    if (lower.indexOf('gvg') !== -1) return 'ph-flag-banner';
    if (lower.indexOf('shadowfront') !== -1) return 'ph-ghost';
    if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return 'ph-truck';
    if (lower.indexOf('stage a') !== -1) return 'ph-crosshair';
    if (lower.indexOf('stage b') !== -1) return 'ph-target';
    if (lower.indexOf('arms') !== -1) return 'ph-crosshair';
    if (lower.indexOf('glory') !== -1) return 'ph-trophy';
    return 'ph-calendar-dot';
  }

  private renderUpcomingCard(upcoming: any[]): string {
    if (!upcoming || !upcoming.length) {
      return '<div class="gm-empty"><i class="ph ph-calendar-x gm-icon"></i>' +
        '<div class="gm-empty-title">' + legacy.t('overview_no_upcoming') + '</div></div>';
    }

    let html = '<div class="gm-timeline-container">';
    upcoming.forEach((u) => {
      const dateObj = new Date(u.when);
      const timeStr = isNaN(dateObj.getTime()) ? '' : pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes());
      const iconClass = this.getEventIcon(u.name);
      const themeClass = legacy.getEventTheme(u.name);

      html +=
        '<div class="gm-timeline-item">' +
          '<div class="gm-timeline-time-col">' +
            '<div>' + legacy.esc(timeStr) + '</div>' +
            '<div style="font-size: var(--fs-xs); font-weight:500; opacity:0.7;">UTC</div>' +
          '</div>' +
          '<div class="gm-timeline-line-col"><div class="gm-timeline-dot"></div></div>' +
          '<div>' +
            '<div class="gm-task-card ' + themeClass + '">' +
              '<div class="gm-task-card-top">' +
                '<div class="gm-task-status-tag"><i class="ph ph-clock"></i><span>Upcoming</span></div>' +
                '<span class="gm-task-countdown-badge gm-countdown" data-deadline="' + legacy.esc(u.when) + '">' +
                  legacy.esc(formatCountdown(u.when, legacy.t('overview_time_now'))) +
                '</span>' +
              '</div>' +
              '<div class="gm-task-card-body">' +
                '<div class="gm-task-icon-squircle"><i class="ph ' + iconClass + '"></i></div>' +
                '<div class="gm-task-info">' +
                  '<div class="gm-task-title">' + legacy.esc(u.name) + '</div>' +
                  '<div class="gm-task-sub">' + legacy.esc(legacy.formatDateTimeUTC(u.when)) + '</div>' +
                '</div>' +
                '<button class="gm-task-action-btn" title="Event Actions" aria-label="Event actions"><i class="ph ph-dots-three-vertical"></i></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  private startCountdownTicker(): void {
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    const panel = document.getElementById('gm-overview');
    if (!panel || !panel.querySelector('.gm-countdown')) return;
    this.countdownTimer = setInterval(() => {
      if (document.hidden) return;
      const els = document.querySelectorAll('#gm-overview .gm-countdown');
      if (!els.length) { if (this.countdownTimer) clearInterval(this.countdownTimer); this.countdownTimer = null; return; }
      els.forEach((el) => {
        el.textContent = formatCountdown(el.getAttribute('data-deadline'), legacy.t('overview_time_now'));
      });
    }, 1000);
  }

  private statTile(label: string, value: string, trend: string | null, icon: string, accent: boolean, meta: string | null, themeClass: string): string {
    const themeCls = themeClass || 'stat-theme-lime';
    return '<div class="gm-stat-tile ' + themeCls + '">' +
      '<div class="gm-stat-tile-header">' +
        '<div class="gm-stat-tile-label">' + legacy.esc(label) + '</div>' +
        '<div class="gm-task-icon-squircle"><i class="ph ' + icon + '"></i></div>' +
      '</div>' +
      '<div class="gm-stat-tile-value">' + legacy.esc(value) + '</div>' +
      '<div class="gm-stat-tile-footer">' +
        (meta || trend
          ? '<div class="gm-stat-tile-meta' + (trend === 'up' ? ' gm-up' : trend === 'down' ? ' gm-down' : '') + '">' +
            (trend === 'up' ? '<i class="ph ph-trend-up"></i> ' : '') +
            (trend === 'down' ? '<i class="ph ph-trend-down"></i> ' : '') +
            legacy.esc(meta || '') +
            '</div>'
          : '<div class="gm-stat-tile-meta">&nbsp;</div>') +
      '</div>' +
    '</div>';
  }

  private renderActivityCard(activity: any[]): string {
    if (!activity || !activity.length) {
      return '<div class="gm-empty"><i class="ph ph-clock-counter-clockwise gm-icon"></i>' +
        '<div class="gm-empty-title">' + legacy.t('overview_no_activity') + '</div></div>';
    }

    const themeMap: Record<string, string> = {
      'success': 'gm-task-card-lime',
      'info': 'gm-task-card-cyan',
      'danger': 'gm-task-card-lilac'
    };

    let html = '<div class="gm-timeline-container">';
    activity.forEach((a) => {
      const dateObj = new Date(a.when);
      const timeStr = isNaN(dateObj.getTime()) ? '' : pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes());

      let themeClass = legacy.getEventTheme(a.text);
      if (themeClass === 'gm-task-card-dark' && a.color) themeClass = themeMap[a.color] || 'gm-task-card-dark';

      let tagLabel = 'Activity';
      if (a.icon === 'ph-play' || a.icon === 'ph-stop-circle') tagLabel = 'Event';
      else if (a.icon === 'ph-warning-octagon') tagLabel = 'Sanction';
      else if (a.icon === 'ph-user-plus') tagLabel = 'Member';

      html +=
        '<div class="gm-timeline-item">' +
          '<div class="gm-timeline-time-col">' +
            '<div>' + legacy.esc(timeStr) + '</div>' +
            '<div style="font-size: var(--fs-xs); font-weight:500; opacity:0.7;">UTC</div>' +
          '</div>' +
          '<div class="gm-timeline-line-col"><div class="gm-timeline-dot"></div></div>' +
          '<div>' +
            '<div class="gm-task-card ' + themeClass + '">' +
              '<div class="gm-task-card-top">' +
                '<div class="gm-task-status-tag"><i class="ph ' + legacy.esc(a.icon) + '"></i><span>' + legacy.esc(tagLabel) + '</span></div>' +
                '<span class="gm-task-countdown-badge">' + legacy.esc(relativeTime(a.when, legacy.t('overview_time_now'))) + '</span>' +
              '</div>' +
              '<div class="gm-task-card-body">' +
                '<div class="gm-task-icon-squircle"><i class="ph ' + legacy.esc(a.icon) + '"></i></div>' +
                '<div class="gm-task-info">' +
                  '<div class="gm-task-title">' + legacy.esc(a.text) + '</div>' +
                  '<div class="gm-task-sub">' + legacy.esc(legacy.formatDateTimeUTC(a.when)) + '</div>' +
                '</div>' +
                '<button class="gm-task-action-btn" title="Activity Actions" aria-label="Activity actions"><i class="ph ph-dots-three-vertical"></i></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  private openManageClocksModal(panel: ParentNode): void {
    const existing = document.getElementById('gm-clocks-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'gm-clocks-overlay';
    overlay.className = 'gm-modal-overlay';

    let tzOptions = '<option value="">-- Or choose Timezone (IANA) --</option>';
    const tzRegions = Array.from(new Set(COMMON_TIMEZONES.map((z) => z.region)));
    tzRegions.forEach((region) => {
      const zones = COMMON_TIMEZONES.filter((z) => z.region === region);
      tzOptions += '<optgroup label="' + legacy.esc(region) + '">';
      zones.forEach((z) => {
        tzOptions += '<option value="' + legacy.esc(z.zone) + '">' + legacy.esc(z.label) + '</option>';
      });
      tzOptions += '</optgroup>';
    });

    let offsetOptions = '';
    for (let o = -12; o <= 14; o += 0.5) {
      const sign = o >= 0 ? '+' : '';
      offsetOptions += '<option value="' + o + '"' + (o === 0 ? ' selected' : '') + '>UTC' + sign + o + '</option>';
    }

    overlay.innerHTML =
      '<div class="gm-modal-card" style="max-width: 450px; width: 95%; text-align: left; padding: 1.5rem;">' +
        '<h3 style="font-family: var(--font-display); margin-bottom: 1rem; text-align: center; font-size: var(--fs-xl);">' + legacy.t('modal_manage_clocks_title') + '</h3>' +
        '<div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">' +
          '<button type="button" id="gm-sync-officers-clocks-btn" class="gm-btn gm-btn-ghost gm-btn-sm" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.4rem;">' +
            '<i class="ph ph-arrows-clockwise"></i> Auto-sync with Officers (R4/R5)' +
          '</button>' +
        '</div>' +
        '<div id="gm-clocks-list-container" class="gm-col" style="gap: .6rem; max-height: 220px; overflow-y: auto; margin-bottom: 1.5rem; padding-right: 4px;"></div>' +
        '<div style="border-top: 1px solid var(--border-soft); padding-top: 1.2rem;">' +
          '<h4 style="font-size: var(--fs-base); font-weight: 600; color: var(--fg-muted); margin-bottom: 0.6rem;">' + legacy.t('modal_add_clock_section') + '</h4>' +
          '<div class="gm-col" style="gap: 0.6rem;">' +
            '<input type="text" id="gm-new-clock-name" class="gm-input" placeholder="' + legacy.t('modal_add_clock_name_placeholder') + '" maxlength="20">' +
            '<select id="gm-new-clock-tz" class="gm-select" style="padding: .55rem .75rem;">' + tzOptions + '</select>' +
            '<div style="display: flex; gap: 0.5rem;">' +
              '<select id="gm-new-clock-offset" class="gm-select" style="flex: 1; padding: .55rem .75rem;">' + offsetOptions + '</select>' +
              '<button id="gm-add-clock-btn" class="gm-btn gm-btn-primary" style="flex-shrink: 0;"><i class="ph ph-plus"></i> ' + legacy.t('modal_add_clock_btn') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="confirm-actions" style="margin-top: 1.5rem; gap: 1rem; justify-content: flex-end;">' +
          '<button id="gm-clocks-modal-close" class="gm-btn gm-btn-ghost">' + legacy.t('modal_clocks_close') + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    winAny().requestAnimationFrame(() => { overlay.classList.add('visible'); });

    const modalClose = (): void => {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.remove(); }, 250);
    };

    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) modalClose(); });
    const closeBtn = document.getElementById('gm-clocks-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', modalClose);

    const renderModalClocks = (): void => {
      const listContainer = overlay.querySelector('#gm-clocks-list-container');
      if (!listContainer) return;

      if (this.clockMembers.length === 0) {
        listContainer.innerHTML = '<div class="gm-empty" style="padding: 1.5rem 0;"><i class="ph ph-ghost gm-icon" style="font-size: var(--fs-3xl); margin-bottom: 0.4rem;"></i><div class="gm-empty-title" style="font-size: var(--fs-base);">No clocks configured</div></div>';
        return;
      }

      let html = '';
      this.clockMembers.forEach((m, idx) => {
        const initials = legacy.avatarInit(m.name);
        const offsetText = formatOffsetLabel(m.offset) + (m.timezone ? ' (' + m.timezone + ')' : '');
        html +=
          '<div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-1); border: 1px solid var(--border-soft); padding: 0.5rem 0.75rem; border-radius: 8px; gap: 0.5rem;">' +
            '<div style="display: flex; align-items: center; gap: 0.6rem; min-width: 0;">' +
              '<div class="gm-avatar gm-avatar-sm gm-avatar-' + m.color + '" style="flex-shrink:0;">' + legacy.esc(initials) + '</div>' +
              '<div style="min-width: 0;">' +
                '<div style="font-weight: 600; font-size: var(--fs-base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + legacy.esc(m.name) + '</div>' +
                '<div style="font-size: var(--fs-xs); color: var(--fg-dim);">' + legacy.esc(offsetText) + '</div>' +
              '</div>' +
            '</div>' +
            '<button class="gm-mini-btn gm-danger delete-clock-btn" data-index="' + idx + '" title="Delete" style="flex-shrink:0;"><i class="ph ph-trash"></i></button>' +
          '</div>';
      });
      listContainer.innerHTML = html;

      listContainer.querySelectorAll('.delete-clock-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.getAttribute('data-index') || '0', 10);
          this.clockMembers.splice(idx, 1);
          await legacy.configSet('timezone_clocks', serializeTimezoneClocks(this.clockMembers));
          legacy.showToast(legacy.t('toast_clock_deleted'), 'info');
          renderModalClocks();
          this.renderTimezoneClocks(panel);
        });
      });
    };

    const syncBtn = overlay.querySelector('#gm-sync-officers-clocks-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        const db = legacy.getDb();
        if (!db) return;
        const currentG = legacy.getActiveGuild();
        try {
          const res = await db.from('guild_members').select('pseudo, role, timezone, timezone_offset').eq('guild', currentG);
          if (res.error) throw res.error;
          const officerClocks = buildOfficerClocks(res.data || []);
          this.clockMembers = officerClocks;
          await legacy.configSet('timezone_clocks', serializeTimezoneClocks(this.clockMembers));
          legacy.showToast('Clocks synced with guild officers!', 'success');
          renderModalClocks();
          this.renderTimezoneClocks(panel);
        } catch (err: any) {
          legacy.showToast('Failed to sync officer clocks: ' + err.message, 'error');
        }
      });
    }

    const tzSelect = document.getElementById('gm-new-clock-tz') as HTMLSelectElement | null;
    const offsetSelect = document.getElementById('gm-new-clock-offset') as HTMLSelectElement | null;
    if (tzSelect && offsetSelect) {
      tzSelect.addEventListener('change', () => {
        const zone = tzSelect.value;
        if (zone) {
          const off = getTimezoneOffset(zone);
          offsetSelect.value = String(off);
        }
      });
    }

    const addBtn = document.getElementById('gm-add-clock-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const nameInput = document.getElementById('gm-new-clock-name') as HTMLInputElement | null;
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) {
          legacy.showToast(legacy.t('toast_clock_name_empty'), 'error');
          return;
        }
        const tzVal = tzSelect && tzSelect.value ? tzSelect.value : null;
        const offset = tzVal ? getTimezoneOffset(tzVal) : parseFloat(offsetSelect ? offsetSelect.value : '0');

        const colors = ['accent', 'info', 'success', 'warning', 'danger'];
        const color = colors[this.clockMembers.length % colors.length];

        this.clockMembers.push({ name, offset, color, timezone: tzVal || null });
        await legacy.configSet('timezone_clocks', serializeTimezoneClocks(this.clockMembers));
        legacy.showToast(legacy.t('toast_clock_added'), 'success');
        if (nameInput) nameInput.value = '';

        renderModalClocks();
        this.renderTimezoneClocks(panel);
      });
    }

    renderModalClocks();
  }
}

/** Shared singleton instance (bridged to `window.GM_OVERVIEW` at cutover). */
export const overviewView = new OverviewView();

export default overviewView;
