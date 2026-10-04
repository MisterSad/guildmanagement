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

import { styleRef } from '../../../core/dom/style-refs';
import { adoptDialog } from '../../../components/ui/Dialog';
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
  buildOfficerClocks,
  hasDiscordWebhook,
  queryMemberCount,
  queryEventStatus,
  queryGloryScores,
  queryRecentSanctions,
  queryRecentMembers,
  queryRecentTransfers,
  queryMemberPower,
  queryOfficerTimezones,
  queryGuildOfficerTimezones,
  fetchConfiguredWebhooks,
} from '../overview.service';
import { escapeHTML, formatNumber, avatarInit } from '../../../core/utils/text';
import { t } from '../../../core/i18n/i18n';
import { getClient } from '../../../core/api/supabase';
import { getActiveGuild } from '../../../core/auth/roles';
import { getWeekStart, getPrevWeekStart, formatDateTimeUTC } from '../../../core/utils/date';
import { getEventIcon, getEventTheme } from '../../../core/config/events';
import { showToast } from '../../../core/dom/toast';
import { config } from '../../../core/config/guild-config';
import { exportGuildData } from '../../ocr/ocr.service';
import {
  COMMON_TIMEZONES,
  formatOffsetLabel,
  formatTimeInZone,
  isValidTimezone,
  getTimezoneOffset,
} from '../../../utils/timezone';

export class OverviewView {
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private timezoneClockTimer: ReturnType<typeof setInterval> | null = null;
  private clockMembers: ClockMember[] = [];

  public getState(): { clockMembers: ClockMember[] } {
    return { clockMembers: this.clockMembers };
  }

  public destroy(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.timezoneClockTimer) {
      clearInterval(this.timezoneClockTimer);
      this.timezoneClockTimer = null;
    }
  }

  public async load(): Promise<void> {
    const panel = document.getElementById('gm-overview');
    if (!panel) return;

    try {
      const clocksStr = await config.get('timezone_clocks');
      this.clockMembers = clocksStr ? parseTimezoneClocks(clocksStr) : getDefaultClocks();
    } catch (e) {
      console.error('Failed to load timezone clocks', e);
      this.clockMembers = getDefaultClocks();
    }

    this.renderShell(panel);

    const db = getClient();
    if (!db) return;

    void this.renderDiscordSetupCallout(panel, db);

    try {
      const week = getWeekStart();
      const prevWeek = getPrevWeekStart(week);
      const currentG = getActiveGuild();

      let memCountQ = queryMemberCount(db);
      let statusQ = queryEventStatus(db);
      let gloryQ = queryGloryScores(db, week);
      let gloryPrevQ = queryGloryScores(db, prevWeek);
      let sanctionsQ = queryRecentSanctions(db);
      let recentMemQ = queryRecentMembers(db);
      const transfersQ = queryRecentTransfers(db, currentG);
      let powerQ = queryMemberPower(db);
      let officersQ = queryOfficerTimezones(db);

      memCountQ = memCountQ.eq('guild', currentG);
      statusQ = statusQ.eq('guild', currentG);
      gloryQ = gloryQ.eq('guild', currentG);
      gloryPrevQ = gloryPrevQ.eq('guild', currentG);
      sanctionsQ = sanctionsQ.eq('guild', currentG);
      recentMemQ = recentMemQ.eq('guild', currentG);
      powerQ = powerQ.eq('guild', currentG);
      officersQ = officersQ.eq('guild', currentG);

      const [
        memCount,
        statusRows,
        gloryRows,
        gloryPrevRows,
        sanctionsRows,
        recentMembers,
        transfersRows,
        powerRows,
        officersRows,
      ] = await Promise.all([
        memCountQ,
        statusQ,
        gloryQ,
        gloryPrevQ,
        sanctionsQ,
        recentMemQ,
        transfersQ,
        powerQ,
        officersQ,
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
        totalPower: ((powerRows.data || []) as any[]).reduce((a, m) => a + (parseInt(m.overall_power, 10) || 0), 0),
      };

      // Activity feed: merge events + sanctions + new members + transfers.
      let activity: Array<{ icon: string; color: string; text: string; when: string }> = [];
      ((statusRows.data || []) as any[]).forEach((s) => {
        if (!s.updated_at) return;
        activity.push({
          icon: s.is_active ? 'ph-play' : 'ph-stop-circle',
          color: s.is_active ? 'success' : 'info',
          text:
            prettyEventName(s.event_name) + ' ' + t(s.is_active ? 'overview_event_started' : 'overview_event_ended'),
          when: s.updated_at,
        });
      });
      ((sanctionsRows.data || []) as any[]).forEach((s) => {
        activity.push({
          icon: 'ph-warning-octagon',
          color: 'danger',
          text: t('overview_sanction_for') + ' ' + s.pseudo + (s.created_by ? ' (' + s.created_by + ')' : ''),
          when: s.created_at,
        });
      });
      ((recentMembers.data || []) as any[]).forEach((m) => {
        activity.push({
          icon: 'ph-user-plus',
          color: 'success',
          text: m.pseudo + ' ' + t('overview_member_added'),
          when: m.created_at,
        });
      });
      ((transfersRows.data || []) as any[]).forEach((t) => {
        const isIncoming = t.target_guild === currentG;
        const text = isIncoming
          ? t.pseudo + ' transferred from ' + t.source_guild
          : t.pseudo + ' transferred to ' + t.target_guild;
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
      showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    }
  }

  /**
   * "Discord reminders are not set up" -- shown to the guild's admins while no
   * webhook exists anywhere in its config. Without one, no reminder, creation
   * post or GvG task list can be sent, and the toggles give no hint of it.
   * A failed read shows nothing rather than a false alarm.
   */
  private async renderDiscordSetupCallout(panel: HTMLElement, db: any): Promise<void> {
    const slot = panel.querySelector('[data-gm-discord-setup]') as HTMLElement | null;
    const guild = getActiveGuild();
    if (!slot || !guild) return;
    try {
      const res = await fetchConfiguredWebhooks(db, guild);
      if (res.error || hasDiscordWebhook(res.data)) return;
    } catch (_) {
      return;
    }
    slot.innerHTML =
      '<div class="u-d-flex u-items-center u-gap-0_85rem u-wrap-wrap u-p-0_85rem-1rem u-mb-1_25rem u-bl-3px-solid-warning gm-card" role="status">' +
      '<i class="u-fs-fs-2xl u-c-warning ph ph-bell-slash" aria-hidden="true"></i>' +
      '<div class="u-flex-1 u-minw-200px">' +
      '<div class="u-fw-700">Discord reminders are not set up</div>' +
      '<div class="u-fs-fs-sm gm-dim">Add a Discord webhook so your players get event reminders, GvG daily tasks and SvS alerts automatically.</div>' +
      '</div>' +
      '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm" data-gm-discord-setup-go><i class="ph ph-arrow-right"></i> <span>Set up</span></button>' +
      '</div>';
    const go = slot.querySelector('[data-gm-discord-setup-go]');
    if (go)
      go.addEventListener('click', () => {
        // The shell owns navigation and already imports this view; going through
        // its own nav entry avoids an import cycle.
        const nav = document.querySelector('[data-gm-nav-item="discord"]') as HTMLElement | null;
        if (nav) nav.click();
      });
  }

  private renderShell(panel: HTMLElement): void {
    // Reset any previous tickers before re-rendering.
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.timezoneClockTimer) {
      clearInterval(this.timezoneClockTimer);
      this.timezoneClockTimer = null;
    }

    panel.innerHTML =
      '<div class="gm-page">' +
      '<header class="gm-page-header">' +
      '<div>' +
      '<h1 class="gm-page-title">' +
      t('gm_overview_title') +
      '</h1>' +
      '<p class="gm-page-subtitle">' +
      t('gm_overview_sub_real') +
      '</p>' +
      '</div>' +
      '<button type="button" class="gm-btn gm-btn-ghost" id="gm-export-guild-data-btn">' +
      '<i class="ph ph-download-simple"></i> <span>' +
      t('overview_export_guild_data') +
      '</span>' +
      '</button>' +
      '</header>' +
      '<div data-gm-discord-setup></div>' +
      '<div class="u-mb-0_75rem u-items-center gm-section-head">' +
      '<h3 class="u-ff-font-display u-fs-fs-xl u-fw-600 u-d-flex u-items-center u-gap-0_5rem u-m-0"><i class="ph ph-clock"></i> Clocks</h3>' +
      '<button class="gm-mini-btn" id="gm-manage-clocks-btn"><i class="ph ph-gear"></i> ' +
      t('manage_clocks') +
      '</button>' +
      '</div>' +
      '<div class="u-mb-2rem gm-overview-clocks" id="gm-overview-clocks"></div>' +
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
          const exportGuild = getActiveGuild();
          // H2: exporting with an unresolved tenant would have exported ALPHA.
          if (!exportGuild) throw new Error('guild_unresolved');
          const res = await exportGuildData(exportGuild);
          if (!res.ok) throw new Error(res.error || 'export_failed');
        } catch (err: any) {
          showToast(t('toast_err_generic') + ' ' + err.message, 'error');
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
        '<div class="gm-empty-hint">Add an officer\'s timezone with "' +
        escapeHTML(t('manage_clocks')) +
        '" above.</div>' +
        '</div>';
      return;
    }

    let html = '';
    this.clockMembers.forEach((m) => {
      const initials = avatarInit(m.name);
      const offsetText = formatOffsetLabel(m.offset);
      const roleBadge = m.role ? ' <span class="u-fs-fs-xs u-opacity-0_8">(' + escapeHTML(m.role) + ')</span>' : '';
      html +=
        '<div class="gm-clock-card" data-offset="' +
        m.offset +
        '" data-timezone="' +
        escapeHTML(m.timezone || '') +
        '">' +
        '<div class="gm-avatar gm-avatar-sm gm-avatar-' +
        m.color +
        '">' +
        escapeHTML(initials) +
        '</div>' +
        '<div class="gm-clock-info">' +
        '<div class="gm-clock-name">' +
        escapeHTML(m.name) +
        roleBadge +
        '</div>' +
        '<div class="gm-clock-meta">' +
        '<span>' +
        offsetText +
        '</span>' +
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
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;

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
        const targetDate = new Date(utcMs + 3600000 * offset);
        timeStr =
          pad2(targetDate.getHours()) + ':' + pad2(targetDate.getMinutes()) + ':' + pad2(targetDate.getSeconds());
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
          iconSlot.innerHTML =
            '<i class="ph ' +
            iconClass +
            '" data-gm-style="' +
            styleRef('color: ' + (isDay ? '#fbbf24' : '#a5b4fc') + ';') +
            '"></i>';
        }
      }
    });
  }

  private startTimezoneClockTicker(): void {
    if (this.timezoneClockTimer) {
      clearInterval(this.timezoneClockTimer);
      this.timezoneClockTimer = null;
    }
    const panel = document.getElementById('gm-overview');
    if (!panel || !panel.querySelector('#gm-overview-clocks')) return;
    this.timezoneClockTimer = setInterval(() => {
      if (document.hidden) return;
      const container = document.getElementById('gm-overview-clocks');
      if (!container) {
        if (this.timezoneClockTimer) clearInterval(this.timezoneClockTimer);
        this.timezoneClockTimer = null;
        return;
      }
      if (panel.classList.contains('active')) this.updateClocksTime();
    }, 1000);
  }

  private renderPage(panel: ParentNode, stats: any, activity: any[], upcoming: any[]): void {
    const content = panel.querySelector('[data-gm-overview-content]');
    if (!content) return;

    const liveEventsMeta = stats.liveEvents > 0 ? stats.liveEventNames.join(' · ') : t('overview_no_live');

    const html =
      '<div class="gm-stat-grid">' +
      this.statTile(
        t('overview_s_members'),
        formatNumber(stats.members),
        null,
        'ph-users',
        false,
        'Active Guild Members',
        'stat-theme-lime'
      ) +
      this.statTile(
        'Guild Power',
        formatBigNumber(stats.totalPower, (v) => formatNumber(v)),
        null,
        'ph-gauge',
        false,
        'Total Power of All Members',
        'stat-theme-cyan'
      ) +
      this.statTile(
        t('overview_s_events'),
        String(stats.liveEvents),
        null,
        'ph-clock',
        stats.liveEvents > 0,
        liveEventsMeta,
        'stat-theme-coral'
      ) +
      this.statTile(
        t('overview_s_glory'),
        formatBigNumber(stats.gloryTotal, (v) => formatNumber(v)),
        'up',
        'ph-trophy',
        false,
        t('overview_s_glory_meta'),
        'stat-theme-mint'
      ) +
      '</div>' +
      '<div class="gm-section" id="pending-accounts-card">' +
      '<div class="gm-section-head">' +
      '<div class="u-c-accent-amber u-fw-700 gm-section-title">' +
      '<i class="ph ph-user-plus"></i>' +
      '<span>Pending Account Validations (Player Portal)</span>' +
      '<span class="gm-count" id="pending-account-count">0</span>' +
      '</div>' +
      '</div>' +
      '<div id="pending-account-list">' +
      '<div class="u-p-1_25rem gm-empty">' +
      '<i class="ph ph-hourglass gm-icon"></i>' +
      '<div class="gm-empty-title">No pending registrations</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="gm-section">' +
      '<div class="gm-section-head">' +
      '<div class="gm-section-title"><i class="ph ph-calendar-dots"></i> ' +
      t('overview_upcoming_title') +
      '</div>' +
      '</div>' +
      this.renderUpcomingCard(upcoming) +
      '</div>' +
      '<div class="gm-section">' +
      '<div class="gm-section-head">' +
      '<div class="gm-section-title"><i class="ph ph-pulse"></i> ' +
      t('overview_recent_activity') +
      '</div>' +
      '</div>' +
      this.renderActivityCard(activity) +
      '</div>';

    content.innerHTML = html;

    // The pending-registrations slot above is filled by the admin accounts
    // render (guild-requests.controller#renderPendingRegistrations). The view
    // used to call `window.GM.renderPendingRegistrations()` here, but nothing
    // ever installed that member, so the call was a no-op and is gone.

    this.startCountdownTicker();
  }

  private getEventIcon(name: string): string {
    return getEventIcon(name);
  }

  private renderUpcomingCard(upcoming: any[]): string {
    if (!upcoming || !upcoming.length) {
      return (
        '<div class="gm-empty"><i class="ph ph-calendar-x gm-icon"></i>' +
        '<div class="gm-empty-title">' +
        t('overview_no_upcoming') +
        '</div></div>'
      );
    }

    let html = '<div class="gm-timeline-container">';
    upcoming.forEach((u) => {
      const dateObj = new Date(u.when);
      const timeStr = isNaN(dateObj.getTime()) ? '' : pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes());
      const iconClass = this.getEventIcon(u.name);
      const themeClass = getEventTheme(u.name);

      html +=
        '<div class="gm-timeline-item">' +
        '<div class="gm-timeline-time-col">' +
        '<div>' +
        escapeHTML(timeStr) +
        '</div>' +
        '<div class="u-fs-fs-xs u-fw-500 u-opacity-0_7">UTC</div>' +
        '</div>' +
        '<div class="gm-timeline-line-col"><div class="gm-timeline-dot"></div></div>' +
        '<div>' +
        '<div class="gm-task-card ' +
        themeClass +
        '">' +
        '<div class="gm-task-card-top">' +
        '<div class="gm-task-status-tag"><i class="ph ph-clock"></i><span>Upcoming</span></div>' +
        '<span class="gm-task-countdown-badge gm-countdown" data-deadline="' +
        escapeHTML(u.when) +
        '">' +
        escapeHTML(formatCountdown(u.when, t('overview_time_now'))) +
        '</span>' +
        '</div>' +
        '<div class="gm-task-card-body">' +
        '<div class="gm-task-icon-squircle"><i class="ph ' +
        iconClass +
        '"></i></div>' +
        '<div class="gm-task-info">' +
        '<div class="gm-task-title">' +
        escapeHTML(u.name) +
        '</div>' +
        '<div class="gm-task-sub">' +
        escapeHTML(formatDateTimeUTC(u.when)) +
        '</div>' +
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
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const panel = document.getElementById('gm-overview');
    if (!panel || !panel.querySelector('.gm-countdown')) return;
    this.countdownTimer = setInterval(() => {
      if (document.hidden) return;
      const els = document.querySelectorAll('#gm-overview .gm-countdown');
      if (!els.length) {
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        return;
      }
      els.forEach((el) => {
        el.textContent = formatCountdown(el.getAttribute('data-deadline'), t('overview_time_now'));
      });
    }, 1000);
  }

  private statTile(
    label: string,
    value: string,
    trend: string | null,
    icon: string,
    _accent: boolean,
    meta: string | null,
    themeClass: string
  ): string {
    const themeCls = themeClass || 'stat-theme-lime';
    return (
      '<div class="gm-stat-tile ' +
      themeCls +
      '">' +
      '<div class="gm-stat-tile-header">' +
      '<div class="gm-stat-tile-label">' +
      escapeHTML(label) +
      '</div>' +
      '<div class="gm-task-icon-squircle"><i class="ph ' +
      icon +
      '"></i></div>' +
      '</div>' +
      '<div class="gm-stat-tile-value">' +
      escapeHTML(value) +
      '</div>' +
      '<div class="gm-stat-tile-footer">' +
      (meta || trend
        ? '<div class="gm-stat-tile-meta' +
          (trend === 'up' ? ' gm-up' : trend === 'down' ? ' gm-down' : '') +
          '">' +
          (trend === 'up' ? '<i class="ph ph-trend-up"></i> ' : '') +
          (trend === 'down' ? '<i class="ph ph-trend-down"></i> ' : '') +
          escapeHTML(meta || '') +
          '</div>'
        : '<div class="gm-stat-tile-meta">&nbsp;</div>') +
      '</div>' +
      '</div>'
    );
  }

  private renderActivityCard(activity: any[]): string {
    if (!activity || !activity.length) {
      return (
        '<div class="gm-empty"><i class="ph ph-clock-counter-clockwise gm-icon"></i>' +
        '<div class="gm-empty-title">' +
        t('overview_no_activity') +
        '</div></div>'
      );
    }

    const themeMap: Record<string, string> = {
      'success': 'gm-task-card-lime',
      'info': 'gm-task-card-cyan',
      'danger': 'gm-task-card-lilac',
    };

    let html = '<div class="gm-timeline-container">';
    activity.forEach((a) => {
      const dateObj = new Date(a.when);
      const timeStr = isNaN(dateObj.getTime()) ? '' : pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes());

      let themeClass = getEventTheme(a.text);
      if (themeClass === 'gm-task-card-dark' && a.color) themeClass = themeMap[a.color] || 'gm-task-card-dark';

      let tagLabel = 'Activity';
      if (a.icon === 'ph-play' || a.icon === 'ph-stop-circle') tagLabel = 'Event';
      else if (a.icon === 'ph-warning-octagon') tagLabel = 'Sanction';
      else if (a.icon === 'ph-user-plus') tagLabel = 'Member';

      html +=
        '<div class="gm-timeline-item">' +
        '<div class="gm-timeline-time-col">' +
        '<div>' +
        escapeHTML(timeStr) +
        '</div>' +
        '<div class="u-fs-fs-xs u-fw-500 u-opacity-0_7">UTC</div>' +
        '</div>' +
        '<div class="gm-timeline-line-col"><div class="gm-timeline-dot"></div></div>' +
        '<div>' +
        '<div class="gm-task-card ' +
        themeClass +
        '">' +
        '<div class="gm-task-card-top">' +
        '<div class="gm-task-status-tag"><i class="ph ' +
        escapeHTML(a.icon) +
        '"></i><span>' +
        escapeHTML(tagLabel) +
        '</span></div>' +
        '<span class="gm-task-countdown-badge">' +
        escapeHTML(relativeTime(a.when, t('overview_time_now'))) +
        '</span>' +
        '</div>' +
        '<div class="gm-task-card-body">' +
        '<div class="gm-task-icon-squircle"><i class="ph ' +
        escapeHTML(a.icon) +
        '"></i></div>' +
        '<div class="gm-task-info">' +
        '<div class="gm-task-title">' +
        escapeHTML(a.text) +
        '</div>' +
        '<div class="gm-task-sub">' +
        escapeHTML(formatDateTimeUTC(a.when)) +
        '</div>' +
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
      tzOptions += '<optgroup label="' + escapeHTML(region) + '">';
      zones.forEach((z) => {
        tzOptions += '<option value="' + escapeHTML(z.zone) + '">' + escapeHTML(z.label) + '</option>';
      });
      tzOptions += '</optgroup>';
    });

    let offsetOptions = '';
    for (let o = -12; o <= 14; o += 0.5) {
      const sign = o >= 0 ? '+' : '';
      offsetOptions += '<option value="' + o + '"' + (o === 0 ? ' selected' : '') + '>UTC' + sign + o + '</option>';
    }

    overlay.innerHTML =
      '<div class="u-maxw-450px u-w-95pct u-text-left u-p-1_5rem gm-modal-card">' +
      '<h3 class="u-ff-font-display u-mb-1rem u-text-center u-fs-fs-xl">' +
      t('modal_manage_clocks_title') +
      '</h3>' +
      '<div class="u-d-flex u-gap-0_5rem u-mb-1rem">' +
      '<button type="button" id="gm-sync-officers-clocks-btn" class="u-w-100pct u-d-flex u-items-center u-justify-center u-gap-0_4rem gm-btn gm-btn-ghost gm-btn-sm">' +
      '<i class="ph ph-arrows-clockwise"></i> Auto-sync with Officers (R4/R5)' +
      '</button>' +
      '</div>' +
      '<div id="gm-clocks-list-container" class="u-gap-0_6rem u-maxh-220px u-oy-auto u-mb-1_5rem u-pr-4px gm-col"></div>' +
      '<div class="u-bt-1px-solid-border-soft u-pt-1_2rem">' +
      '<h4 class="u-fs-fs-base u-fw-600 u-c-fg-muted u-mb-0_6rem">' +
      t('modal_add_clock_section') +
      '</h4>' +
      '<div class="u-gap-0_6rem gm-col">' +
      '<input type="text" id="gm-new-clock-name" class="gm-input" placeholder="' +
      t('modal_add_clock_name_placeholder') +
      '" aria-label="' +
      escapeHTML(t('modal_add_clock_name_placeholder')) +
      '" maxlength="20">' +
      '<select id="gm-new-clock-tz" class="u-p-0_55rem-0_75rem gm-select" aria-label="' +
      escapeHTML(t('a11y_clock_timezone')) +
      '">' +
      tzOptions +
      '</select>' +
      '<div class="u-d-flex u-gap-0_5rem">' +
      '<select id="gm-new-clock-offset" class="u-flex-1 u-p-0_55rem-0_75rem gm-select" aria-label="' +
      escapeHTML(t('a11y_clock_offset')) +
      '">' +
      offsetOptions +
      '</select>' +
      '<button id="gm-add-clock-btn" class="u-shrink-0 gm-btn gm-btn-primary"><i class="ph ph-plus"></i> ' +
      t('modal_add_clock_btn') +
      '</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="u-mt-1_5rem u-gap-1rem u-justify-flex-end confirm-actions">' +
      '<button id="gm-clocks-modal-close" class="gm-btn gm-btn-ghost">' +
      t('modal_clocks_close') +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    window.requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });

    const modalClose = (): void => {
      overlay.classList.remove('visible');
      setTimeout(() => {
        overlay.remove();
      }, 250);
    };

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) modalClose();
    });
    const closeBtn = document.getElementById('gm-clocks-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', modalClose);
    adoptDialog(overlay, { onEscape: modalClose });

    const renderModalClocks = (): void => {
      const listContainer = overlay.querySelector('#gm-clocks-list-container');
      if (!listContainer) return;

      if (this.clockMembers.length === 0) {
        listContainer.innerHTML =
          '<div class="u-p-1_5rem-0 gm-empty"><i class="u-fs-fs-3xl u-mb-0_4rem ph ph-ghost gm-icon"></i><div class="u-fs-fs-base gm-empty-title">No clocks configured</div></div>';
        return;
      }

      let html = '';
      this.clockMembers.forEach((m, idx) => {
        const initials = avatarInit(m.name);
        const offsetText = formatOffsetLabel(m.offset) + (m.timezone ? ' (' + m.timezone + ')' : '');
        html +=
          '<div class="u-d-flex u-items-center u-justify-space-between u-bg-bg-1 u-border-1px-solid-border-soft u-p-0_5rem-0_75rem u-rounded-8px u-gap-0_5rem">' +
          '<div class="u-d-flex u-items-center u-gap-0_6rem u-minw-0">' +
          '<div class="u-shrink-0 gm-avatar gm-avatar-sm gm-avatar-' +
          m.color +
          '">' +
          escapeHTML(initials) +
          '</div>' +
          '<div class="u-minw-0">' +
          '<div class="u-fw-600 u-fs-fs-base u-overflow-hidden u-to-ellipsis u-ws-nowrap">' +
          escapeHTML(m.name) +
          '</div>' +
          '<div class="u-fs-fs-xs u-c-fg-dim">' +
          escapeHTML(offsetText) +
          '</div>' +
          '</div>' +
          '</div>' +
          '<button class="u-shrink-0 gm-mini-btn gm-danger delete-clock-btn" data-index="' +
          idx +
          '" title="Delete"><i class="ph ph-trash"></i></button>' +
          '</div>';
      });
      listContainer.innerHTML = html;

      listContainer.querySelectorAll('.delete-clock-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.getAttribute('data-index') || '0', 10);
          this.clockMembers.splice(idx, 1);
          await config.set('timezone_clocks', serializeTimezoneClocks(this.clockMembers));
          showToast(t('toast_clock_deleted'), 'info');
          renderModalClocks();
          this.renderTimezoneClocks(panel);
        });
      });
    };

    const syncBtn = overlay.querySelector('#gm-sync-officers-clocks-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        const db = getClient();
        if (!db) return;
        const currentG = getActiveGuild();
        try {
          const res = await queryGuildOfficerTimezones(db, currentG);
          if (res.error) throw res.error;
          const officerClocks = buildOfficerClocks(res.data || []);
          this.clockMembers = officerClocks;
          await config.set('timezone_clocks', serializeTimezoneClocks(this.clockMembers));
          showToast('Clocks synced with guild officers!', 'success');
          renderModalClocks();
          this.renderTimezoneClocks(panel);
        } catch (err: any) {
          showToast('Failed to sync officer clocks: ' + err.message, 'error');
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
          showToast(t('toast_clock_name_empty'), 'error');
          return;
        }
        const tzVal = tzSelect && tzSelect.value ? tzSelect.value : null;
        const offset = tzVal ? getTimezoneOffset(tzVal) : parseFloat(offsetSelect ? offsetSelect.value : '0');

        const colors = ['accent', 'info', 'success', 'warning', 'danger'];
        const color = colors[this.clockMembers.length % colors.length];

        this.clockMembers.push({ name, offset, color, timezone: tzVal || null });
        await config.set('timezone_clocks', serializeTimezoneClocks(this.clockMembers));
        showToast(t('toast_clock_added'), 'success');
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
