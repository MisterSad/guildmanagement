/**
 * overview.js — Page Vue d'ensemble (Dashboard).
 *
 * Stats live dérivées des tables existantes :
 *   - Membres actifs   : count(guild_members)
 *   - Événements live  : count(event_status WHERE is_active=true)
 *   - Gloire totale    : sum(event_participants.score) Glory cette semaine
 *   - Sanctions        : count(sanctions)
 *
 * Recent activity : mix de event_status.updated_at, sanctions.created_at,
 * guild_members.created_at, top 6 par date desc.
 *
 * Quick actions : raccourcis vers les onglets/forms existants.
 */
(function () {

    if (!window.GM) return;

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t   = window.GM.t;
    var esc = window.GM.escapeHTML;
    var fmt = window.GM.formatNumber;

    var countdownTimer = null;
    var timezoneClockTimer = null;

    var CLOCK_MEMBERS = [];

    function getDefaultClocks() {
        return [
            { name: 'Natalie', offset: 7, color: 'danger' },
            { name: 'HawkTuah', offset: 2, color: 'accent' },
            { name: 'Phantom', offset: 2, color: 'info' },
            { name: 'Vaylah', offset: -4, color: 'success' },
            { name: 'BroKen', offset: -7, color: 'warning' }
        ];
    }

    window.GM_OVERVIEW = { load: loadOverview };

    async function loadOverview() {
        var panel = document.getElementById('gm-overview');
        if (!panel) return;

        // Load custom clocks settings from database
        try {
            var clocksStr = await window.GM.config.get('timezone_clocks');
            if (clocksStr) {
                CLOCK_MEMBERS = JSON.parse(clocksStr);
            } else {
                CLOCK_MEMBERS = getDefaultClocks();
                await window.GM.config.set('timezone_clocks', JSON.stringify(CLOCK_MEMBERS));
            }
        } catch (e) {
            console.error('Failed to load timezone clocks', e);
            CLOCK_MEMBERS = getDefaultClocks();
        }

        // Skeleton
        renderShell(panel);

        var db = getDb();
        if (!db) return;

        try {
            var week = window.GM.getWeekStart();
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

            var memCountQ  = db.from('guild_members').select('id', { count: 'exact', head: true });
            var statusQ    = db.from('event_status').select('event_name, is_active, updated_at, session_id, start_at');
            var gloryQ     = db.from('event_participants').select('score').eq('event_name', 'Glory').eq('week_start', week);
            var sanctionsQ = db.from('sanctions').select('id, pseudo, comment, created_by, created_at').order('created_at', { ascending: false }).limit(5);
            var recentMemQ = db.from('guild_members').select('pseudo, created_at').order('created_at', { ascending: false }).limit(5);
            var transfersQ = db.from('guild_transfers').select('pseudo, source_guild, target_guild, resolved_at').eq('status', 'approved').or('source_guild.eq.' + currentG + ',target_guild.eq.' + currentG).order('resolved_at', { ascending: false }).limit(5);
            var powerQ     = db.from('guild_members').select('overall_power');

            memCountQ  = memCountQ.eq('guild', currentG);
            statusQ    = statusQ.eq('guild', currentG);
            gloryQ     = gloryQ.eq('guild', currentG);
            sanctionsQ = sanctionsQ.eq('guild', currentG);
            recentMemQ = recentMemQ.eq('guild', currentG);
            powerQ     = powerQ.eq('guild', currentG);

            var [memCount, statusRows, gloryRows, sanctionsRows, recentMembers, transfersRows, powerRows] = await Promise.all([
                memCountQ, statusQ, gloryQ, sanctionsQ, recentMemQ, transfersQ, powerQ
            ]);

            var stats = {
                members:   memCount.count || 0,
                liveEvents: (statusRows.data || []).filter(function (s) { return s.is_active; }).length,
                liveEventNames: (statusRows.data || []).filter(function (s) { return s.is_active; }).map(function (s) { return prettyEventName(s.event_name); }),
                gloryTotal: (gloryRows.data || []).reduce(function (a, r) { return a + (r.score || 0); }, 0),
                sanctions: (sanctionsRows.data || []).length,
                totalPower: (powerRows.data || []).reduce(function (a, m) { return a + (parseInt(m.overall_power, 10) || 0); }, 0)
            };

            // Activity feed : merge events + sanctions + new members
            var activity = [];
            (statusRows.data || []).forEach(function (s) {
                if (!s.updated_at) return;
                activity.push({
                    icon: s.is_active ? 'ph-play' : 'ph-stop-circle',
                    color: s.is_active ? 'success' : 'info',
                    text: prettyEventName(s.event_name) + ' ' + (s.is_active ? t('overview_event_started') : t('overview_event_ended')),
                    when: s.updated_at
                });
            });
            (sanctionsRows.data || []).forEach(function (s) {
                activity.push({
                    icon: 'ph-warning-octagon',
                    color: 'danger',
                    text: t('overview_sanction_for') + ' ' + s.pseudo + (s.created_by ? ' (' + s.created_by + ')' : ''),
                    when: s.created_at
                });
            });
            (recentMembers.data || []).forEach(function (m) {
                activity.push({
                    icon: 'ph-user-plus',
                    color: 'success',
                    text: m.pseudo + ' ' + t('overview_member_added'),
                    when: m.created_at
                });
            });
            (transfersRows.data || []).forEach(function (t) {
                var isIncoming = t.target_guild === currentG;
                var text = isIncoming ? t.pseudo + ' transferred from ' + t.source_guild : t.pseudo + ' transferred to ' + t.target_guild;
                activity.push({
                    icon: 'ph-swap',
                    color: isIncoming ? 'success' : 'warning',
                    text: text,
                    when: t.resolved_at
                });
            });
            activity.sort(function (a, b) {
                return new Date(b.when).getTime() - new Date(a.when).getTime();
            });
            activity = activity.slice(0, 6);

            // Événements à venir : start_at futur, ordre croissant
            var nowMs = Date.now();
            var upcoming = (statusRows.data || [])
                .filter(function (s) { return s.start_at && new Date(s.start_at).getTime() > nowMs; })
                .map(function (s) { return { name: fullEventName(s.event_name), when: s.start_at }; })
                .sort(function (a, b) { return new Date(a.when).getTime() - new Date(b.when).getTime(); });

            renderPage(panel, stats, activity, upcoming);
        } catch (err) {
            console.error('overview load', err);
            if (window.GM && window.GM.showToast) {
                window.GM.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
            }
        }
    }

    function prettyEventName(n) {
        if (!n) return '';
        if (n === 'ARMS RACE STAGE A') return 'Arms Race Stage A';
        if (n === 'ARMS RACE STAGE B') return 'Arms Race Stage B';
        if (n === 'Shadowfront Squad 1') return 'Shadowfront — Squad 1';
        if (n === 'Shadowfront Squad 2') return 'Shadowfront — Squad 2';
        if (n === 'Defend Trade Route') return 'DTR';
        return n;
    }

    // Like prettyEventName but never abbreviates (used in the upcoming agenda).
    function fullEventName(n) {
        if (!n) return '';
        if (n === 'ARMS RACE STAGE A') return 'Arms Race Stage A';
        if (n === 'ARMS RACE STAGE B') return 'Arms Race Stage B';
        if (n === 'Shadowfront Squad 1') return 'Shadowfront — Squad 1';
        if (n === 'Shadowfront Squad 2') return 'Shadowfront — Squad 2';
        return n;
    }

    function renderShell(panel) {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        if (timezoneClockTimer) { clearInterval(timezoneClockTimer); timezoneClockTimer = null; }
        panel.innerHTML =
            '<div class="gm-page">' +
                '<header class="gm-page-header">' +
                    '<div>' +
                        '<h1 class="gm-page-title">' + t('gm_overview_title') + '</h1>' +
                        '<p class="gm-page-subtitle">' + t('gm_overview_sub_real') + '</p>' +
                    '</div>' +
                '</header>' +
                '<div class="gm-section-head" style="margin-bottom: 0.75rem; align-items: center;">' +
                    '<h3 style="font-family: var(--font-display); font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 0.5rem; margin: 0;"><i class="ph ph-clock"></i> Clocks</h3>' +
                    '<button class="gm-mini-btn" id="gm-manage-clocks-btn"><i class="ph ph-gear"></i> ' + t('manage_clocks') + '</button>' +
                '</div>' +
                '<div class="gm-overview-clocks" id="gm-overview-clocks" style="margin-bottom: 2rem;"></div>' +
                '<div data-gm-overview-content></div>' +
            '</div>';

        renderTimezoneClocks(panel);
        startTimezoneClockTicker();

        var manageBtn = panel.querySelector('#gm-manage-clocks-btn');
        if (manageBtn) {
            manageBtn.addEventListener('click', function () {
                openManageClocksModal(panel);
            });
        }
    }

    function renderTimezoneClocks(panel) {
        var container = panel.querySelector('#gm-overview-clocks');
        if (!container) return;

        var html = '';
        CLOCK_MEMBERS.forEach(function (m) {
            var initials = window.GM.avatarInit(m.name);
            var offsetText = 'UTC' + (m.offset >= 0 ? '+' + m.offset : m.offset);
            html +=
                '<div class="gm-clock-card" data-offset="' + m.offset + '">' +
                    '<div class="gm-avatar gm-avatar-sm gm-avatar-' + m.color + '">' + esc(initials) + '</div>' +
                    '<div class="gm-clock-info">' +
                        '<div class="gm-clock-name">' + esc(m.name) + '</div>' +
                        '<div class="gm-clock-meta">' +
                            '<span>' + offsetText + '</span>' +
                            '<span class="gm-clock-icon-slot"></span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-clock-time">--:--:--</div>' +
                '</div>';
        });
        container.innerHTML = html;
        updateClocksTime();
    }

    function updateClocksTime() {
        var container = document.getElementById('gm-overview-clocks');
        if (!container) return;

        var cards = container.querySelectorAll('.gm-clock-card');
        var now = new Date();
        var utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);

        cards.forEach(function (card) {
            var offset = parseFloat(card.getAttribute('data-offset'));
            var targetDate = new Date(utcMs + (3600000 * offset));

            var hh = pad2(targetDate.getHours());
            var mm = pad2(targetDate.getMinutes());
            var ss = pad2(targetDate.getSeconds());
            var timeStr = hh + ':' + mm + ':' + ss;

            var timeEl = card.querySelector('.gm-clock-time');
            if (timeEl) timeEl.textContent = timeStr;

            var hour = targetDate.getHours();
            var isDay = hour >= 6 && hour < 18;

            var iconSlot = card.querySelector('.gm-clock-icon-slot');
            if (iconSlot) {
                var iconClass = isDay ? 'ph-sun' : 'ph-moon';
                var currentIcon = iconSlot.querySelector('i');
                if (!currentIcon || !currentIcon.classList.contains(iconClass)) {
                    iconSlot.innerHTML = '<i class="ph ' + iconClass + '" style="color: ' + (isDay ? '#fbbf24' : '#a5b4fc') + ';"></i>';
                }
            }
        });
    }

    function startTimezoneClockTicker() {
        if (timezoneClockTimer) { clearInterval(timezoneClockTimer); timezoneClockTimer = null; }
        var panel = document.getElementById('gm-overview');
        if (!panel || !panel.querySelector('#gm-overview-clocks')) return;
        timezoneClockTimer = setInterval(function () {
            var container = document.getElementById('gm-overview-clocks');
            if (!container) { clearInterval(timezoneClockTimer); timezoneClockTimer = null; return; }
            if (panel.classList.contains('active')) {
                updateClocksTime();
            }
        }, 1000);
    }

    function renderPage(panel, stats, activity, upcoming) {
        var content = panel.querySelector('[data-gm-overview-content]');
        if (!content) return;

        var liveEventsMeta = stats.liveEvents > 0
            ? stats.liveEventNames.join(' · ')
            : t('overview_no_live');

        var html =
            '<div class="gm-stat-grid">' +
                statTile(t('overview_s_members'), fmt(stats.members), null, 'ph-users', false, 'Active Guild Members', 'stat-theme-lime') +
                statTile('Guild Power', formatBigNumber(stats.totalPower), null, 'ph-gauge', false, 'Total Power of All Members', 'stat-theme-cyan') +
                statTile(t('overview_s_events'), String(stats.liveEvents), null, 'ph-clock', stats.liveEvents > 0, liveEventsMeta, 'stat-theme-coral') +
                statTile(t('overview_s_glory'), formatBigNumber(stats.gloryTotal), 'up', 'ph-trophy', false, t('overview_s_glory_meta'), 'stat-theme-mint') +
            '</div>' +
            '<div class="gm-section">' +
                '<div class="gm-section-head">' +
                    '<div class="gm-section-title"><i class="ph ph-calendar-dots"></i> ' + t('overview_upcoming_title') + '</div>' +
                    '<div data-gm-notif></div>' +
                '</div>' +
                renderUpcomingCard(upcoming) +
            '</div>' +
            '<div class="gm-section">' +
                '<div class="gm-section-head">' +
                    '<div class="gm-section-title"><i class="ph ph-pulse"></i> ' + t('overview_recent_activity') + '</div>' +
                '</div>' +
                renderActivityCard(activity) +
            '</div>';

        content.innerHTML = html;

        var notifSlot = content.querySelector('[data-gm-notif]');
        if (notifSlot && window.GM_PUSH) window.GM_PUSH.mount(notifSlot);

        startCountdownTicker();
    }

    function getEventIcon(name) {
        if (window.GM && window.GM.getEventIcon) {
            return window.GM.getEventIcon(name);
        }
        if (!name) return 'ph-calendar-dot';
        var lower = name.toLowerCase();
        if (lower.indexOf('svs') !== -1) return 'ph-swords';
        if (lower.indexOf('gvg') !== -1) return 'ph-flag-banner';
        if (lower.indexOf('shadowfront') !== -1) return 'ph-ghost';
        if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return 'ph-truck';
        if (lower.indexOf('stage a') !== -1) return 'ph-crosshair';
        if (lower.indexOf('stage b') !== -1) return 'ph-target';
        if (lower.indexOf('arms') !== -1) return 'ph-crosshair';
        if (lower.indexOf('glory') !== -1) return 'ph-trophy';
        return 'ph-calendar-dot';
    }

    function renderUpcomingCard(upcoming) {
        if (!upcoming || !upcoming.length) {
            return '<div class="gm-empty"><i class="ph-duotone ph-calendar-x gm-icon"></i>' +
                '<div class="gm-empty-title">' + t('overview_no_upcoming') + '</div></div>';
        }

        var html = '<div class="gm-timeline-container">';

        upcoming.forEach(function (u, i) {
            var dateObj = new Date(u.when);
            var timeStr = isNaN(dateObj.getTime())
                ? ''
                : pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes());

            var iconClass = getEventIcon(u.name);
            var themeClass = (window.GM && window.GM.getEventTheme) ? window.GM.getEventTheme(u.name) : 'gm-task-card-dark';

            html +=
                '<div class="gm-timeline-item">' +
                    '<div class="gm-timeline-time-col">' +
                        '<div>' + esc(timeStr) + '</div>' +
                        '<div style="font-size:0.7rem; font-weight:500; opacity:0.7;">UTC</div>' +
                    '</div>' +
                    '<div class="gm-timeline-line-col">' +
                        '<div class="gm-timeline-dot"></div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-task-card ' + themeClass + '">' +
                            '<div class="gm-task-card-top">' +
                                '<div class="gm-task-status-tag">' +
                                    '<i class="ph ph-clock"></i>' +
                                    '<span>Upcoming</span>' +
                                '</div>' +
                                '<span class="gm-task-countdown-badge gm-countdown" data-deadline="' + esc(u.when) + '">' +
                                    esc(formatCountdown(u.when)) +
                                '</span>' +
                            '</div>' +
                            '<div class="gm-task-card-body">' +
                                '<div class="gm-task-icon-squircle">' +
                                    '<i class="ph ' + iconClass + '"></i>' +
                                '</div>' +
                                '<div class="gm-task-info">' +
                                    '<div class="gm-task-title">' + esc(u.name) + '</div>' +
                                    '<div class="gm-task-sub">' + esc(window.GM.formatDateTimeUTC(u.when)) + '</div>' +
                                '</div>' +
                                '<button class="gm-task-action-btn" title="Event Actions" aria-label="Event actions">' +
                                    '<i class="ph ph-dots-three-vertical"></i>' +
                                '</button>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
        });

        html += '</div>';
        return html;
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // Live HH:MM:SS until the deadline (hours not capped at 24). "now" once reached.
    function formatCountdown(iso) {
        var ms = new Date(iso).getTime() - Date.now();
        if (isNaN(ms)) return '';
        if (ms <= 0) return t('overview_time_now');
        var total = Math.floor(ms / 1000);
        return pad2(Math.floor(total / 3600)) + ':' +
               pad2(Math.floor((total % 3600) / 60)) + ':' +
               pad2(total % 60);
    }

    function startCountdownTicker() {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        var panel = document.getElementById('gm-overview');
        if (!panel || !panel.querySelector('.gm-countdown')) return;
        countdownTimer = setInterval(function () {
            var els = document.querySelectorAll('#gm-overview .gm-countdown');
            if (!els.length) { clearInterval(countdownTimer); countdownTimer = null; return; }
            els.forEach(function (el) {
                el.textContent = formatCountdown(el.getAttribute('data-deadline'));
            });
        }, 1000);
    }

    function statTile(label, value, trend, icon, accent, meta, themeClass) {
        var themeCls = themeClass || 'stat-theme-lime';
        return '<div class="gm-stat-tile ' + themeCls + '">' +
            '<div class="gm-stat-tile-header">' +
                '<div class="gm-stat-tile-label">' + esc(label) + '</div>' +
                '<div class="gm-task-icon-squircle">' +
                    '<i class="ph ' + icon + '"></i>' +
                '</div>' +
            '</div>' +
            '<div class="gm-stat-tile-value">' + esc(value) + '</div>' +
            '<div class="gm-stat-tile-footer">' +
                (meta || trend
                    ? '<div class="gm-stat-tile-meta' + (trend === 'up' ? ' gm-up' : trend === 'down' ? ' gm-down' : '') + '">' +
                        (trend === 'up' ? '<i class="ph ph-trend-up"></i> ' : '') +
                        (trend === 'down' ? '<i class="ph ph-trend-down"></i> ' : '') +
                        esc(meta || '') +
                      '</div>'
                    : '<div class="gm-stat-tile-meta">&nbsp;</div>') +
            '</div>' +
        '</div>';
    }

    function renderActivityCard(activity) {
        if (!activity || !activity.length) {
            return '<div class="gm-empty"><i class="ph-duotone ph-clock-counter-clockwise gm-icon"></i>' +
                '<div class="gm-empty-title">' + t('overview_no_activity') + '</div></div>';
        }

        var themeMap = {
            'success': 'gm-task-card-lime',
            'info': 'gm-task-card-cyan',
            'danger': 'gm-task-card-lilac'
        };

        var html = '<div class="gm-timeline-container">';

        activity.forEach(function (a, i) {
            var dateObj = new Date(a.when);
            var timeStr = isNaN(dateObj.getTime())
                ? ''
                : pad2(dateObj.getUTCHours()) + ':' + pad2(dateObj.getUTCMinutes());

            var themeClass = (window.GM && window.GM.getEventTheme) ? window.GM.getEventTheme(a.text) : 'gm-task-card-dark';
            if (themeClass === 'gm-task-card-dark' && a.color) {
                themeClass = themeMap[a.color] || 'gm-task-card-dark';
            }

            var tagLabel = 'Activity';
            if (a.icon === 'ph-play' || a.icon === 'ph-stop-circle') tagLabel = 'Event';
            else if (a.icon === 'ph-warning-octagon') tagLabel = 'Sanction';
            else if (a.icon === 'ph-user-plus') tagLabel = 'Member';

            html +=
                '<div class="gm-timeline-item">' +
                    '<div class="gm-timeline-time-col">' +
                        '<div>' + esc(timeStr) + '</div>' +
                        '<div style="font-size:0.7rem; font-weight:500; opacity:0.7;">UTC</div>' +
                    '</div>' +
                    '<div class="gm-timeline-line-col">' +
                        '<div class="gm-timeline-dot"></div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-task-card ' + themeClass + '">' +
                            '<div class="gm-task-card-top">' +
                                '<div class="gm-task-status-tag">' +
                                    '<i class="ph ' + esc(a.icon) + '"></i>' +
                                    '<span>' + esc(tagLabel) + '</span>' +
                                '</div>' +
                                '<span class="gm-task-countdown-badge">' +
                                    esc(relativeTime(a.when)) +
                                '</span>' +
                            '</div>' +
                            '<div class="gm-task-card-body">' +
                                '<div class="gm-task-icon-squircle">' +
                                    '<i class="ph ' + esc(a.icon) + '"></i>' +
                                '</div>' +
                                '<div class="gm-task-info">' +
                                    '<div class="gm-task-title">' + esc(a.text) + '</div>' +
                                    '<div class="gm-task-sub">' + esc(window.GM.formatDateTimeUTC(a.when)) + '</div>' +
                                '</div>' +
                                '<button class="gm-task-action-btn" title="Activity Actions" aria-label="Activity actions">' +
                                    '<i class="ph ph-dots-three-vertical"></i>' +
                                '</button>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
        });

        html += '</div>';
        return html;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    function formatBigNumber(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
        return fmt(n);
    }

    function relativeTime(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        var diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60)        return t('overview_time_now');
        if (diff < 3600)      return Math.floor(diff / 60) + ' min';
        if (diff < 86400)     return Math.floor(diff / 3600) + ' h';
        if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' j';
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    }

    function openManageClocksModal(panel) {
        var existing = document.getElementById('gm-clocks-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'gm-clocks-overlay';
        overlay.className = 'confirm-overlay';

        var offsetOptions = '';
        for (var o = -12; o <= 14; o += 0.5) {
            var sign = o >= 0 ? '+' : '';
            var val = 'UTC' + sign + o;
            offsetOptions += '<option value="' + o + '"' + (o === 0 ? ' selected' : '') + '>' + val + '</option>';
        }

        overlay.innerHTML =
            '<div class="confirm-card glass-card" style="max-width: 450px; width: 95%; text-align: left; padding: 1.5rem;">' +
                '<h3 style="font-family: var(--font-display); margin-bottom: 1rem; text-align: center; font-size: 1.25rem;">' + t('modal_manage_clocks_title') + '</h3>' +
                '<div id="gm-clocks-list-container" class="gm-col" style="gap: .6rem; max-height: 220px; overflow-y: auto; margin-bottom: 1.5rem; padding-right: 4px;"></div>' +
                '<div style="border-top: 1px solid var(--border-soft); padding-top: 1.2rem;">' +
                    '<h4 style="font-size: 0.85rem; font-weight: 600; color: var(--fg-muted); margin-bottom: 0.6rem;">' + t('modal_add_clock_section') + '</h4>' +
                    '<div class="gm-col" style="gap: 0.6rem;">' +
                        '<input type="text" id="gm-new-clock-name" class="gm-input" placeholder="' + t('modal_add_clock_name_placeholder') + '" maxlength="20">' +
                        '<div style="display: flex; gap: 0.5rem;">' +
                            '<select id="gm-new-clock-offset" class="gm-select" style="flex: 1; padding: .55rem .75rem;">' +
                                offsetOptions +
                            '</select>' +
                            '<button id="gm-add-clock-btn" class="gm-btn gm-btn-primary" style="flex-shrink: 0;"><i class="ph ph-plus"></i> ' + t('modal_add_clock_btn') + '</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="confirm-actions" style="margin-top: 1.5rem; gap: 1rem; justify-content: flex-end;">' +
                    '<button id="gm-clocks-modal-close" class="gm-btn gm-btn-ghost">' + t('modal_clocks_close') + '</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('visible'); });

        var modalClose = function () {
            overlay.classList.remove('visible');
            setTimeout(function () { overlay.remove(); }, 250);
        };

        overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) modalClose();
        });
        document.getElementById('gm-clocks-modal-close').addEventListener('click', modalClose);

        function renderModalClocks() {
            var listContainer = overlay.querySelector('#gm-clocks-list-container');
            if (!listContainer) return;

            if (CLOCK_MEMBERS.length === 0) {
                listContainer.innerHTML = '<div class="gm-empty" style="padding: 1.5rem 0;"><i class="ph ph-ghost gm-icon" style="font-size: 1.8rem; margin-bottom: 0.4rem;"></i><div class="gm-empty-title" style="font-size: 0.85rem;">No clocks configured</div></div>';
                return;
            }

            var html = '';
            CLOCK_MEMBERS.forEach(function (m, idx) {
                var initials = window.GM.avatarInit(m.name);
                var offsetText = 'UTC' + (m.offset >= 0 ? '+' + m.offset : m.offset);
                html +=
                    '<div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-1); border: 1px solid var(--border-soft); padding: 0.5rem 0.75rem; border-radius: 8px; gap: 0.5rem;">' +
                        '<div style="display: flex; align-items: center; gap: 0.6rem; min-width: 0;">' +
                            '<div class="gm-avatar gm-avatar-sm gm-avatar-' + m.color + '" style="flex-shrink:0;">' + esc(initials) + '</div>' +
                            '<div style="min-width: 0;">' +
                                '<div style="font-weight: 600; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + esc(m.name) + '</div>' +
                                '<div style="font-size: 0.72rem; color: var(--fg-dim);">' + offsetText + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<button class="gm-mini-btn gm-danger delete-clock-btn" data-index="' + idx + '" title="Delete" style="flex-shrink:0;"><i class="ph ph-trash"></i></button>' +
                    '</div>';
            });
            listContainer.innerHTML = html;

            listContainer.querySelectorAll('.delete-clock-btn').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    var idx = parseInt(btn.getAttribute('data-index'), 10);
                    CLOCK_MEMBERS.splice(idx, 1);
                    await window.GM.config.set('timezone_clocks', JSON.stringify(CLOCK_MEMBERS));
                    window.GM.showToast(t('toast_clock_deleted'), 'info');
                    renderModalClocks();
                    renderTimezoneClocks(panel);
                });
            });
        }

        document.getElementById('gm-add-clock-btn').addEventListener('click', async function () {
            var nameInput = document.getElementById('gm-new-clock-name');
            var name = nameInput.value.trim();
            if (!name) {
                window.GM.showToast(t('toast_clock_name_empty'), 'error');
                return;
            }

            var offsetSelect = document.getElementById('gm-new-clock-offset');
            var offset = parseFloat(offsetSelect.value);

            var colors = ['accent', 'info', 'success', 'warning', 'danger'];
            var color = colors[CLOCK_MEMBERS.length % colors.length];

            CLOCK_MEMBERS.push({ name: name, offset: offset, color: color });
            await window.GM.config.set('timezone_clocks', JSON.stringify(CLOCK_MEMBERS));
            window.GM.showToast(t('toast_clock_added'), 'success');
            nameInput.value = '';

            renderModalClocks();
            renderTimezoneClocks(panel);
        });

        renderModalClocks();
    }

})();
