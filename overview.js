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

    if (!window.RAD) return;

    var db  = window.RAD.db;
    var t   = window.RAD.t;
    var esc = window.RAD.escapeHTML;
    var fmt = window.RAD.formatNumber;

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

    window.RAD_OVERVIEW = { load: loadOverview };

    async function loadOverview() {
        var panel = document.getElementById('gm-overview');
        if (!panel) return;

        // Load custom clocks settings from database
        try {
            var clocksStr = await window.RAD.config.get('timezone_clocks');
            if (clocksStr) {
                CLOCK_MEMBERS = JSON.parse(clocksStr);
            } else {
                CLOCK_MEMBERS = getDefaultClocks();
                await window.RAD.config.set('timezone_clocks', JSON.stringify(CLOCK_MEMBERS));
            }
        } catch (e) {
            console.error('Failed to load timezone clocks', e);
            CLOCK_MEMBERS = getDefaultClocks();
        }

        // Skeleton
        renderShell(panel);

        if (!db) return;

        try {
            var week = window.RAD.getWeekStart();
            var [memCount, statusRows, gloryRows, sanctionsRows, recentMembers, recentSanctions] = await Promise.all([
                db.from('guild_members').select('id', { count: 'exact', head: true }),
                db.from('event_status').select('event_name, is_active, updated_at, session_id, start_at'),
                db.from('event_participants').select('score').eq('event_name', 'Glory').eq('week_start', week),
                db.from('sanctions').select('id, pseudo, comment, created_by, created_at').order('created_at', { ascending: false }).limit(5),
                db.from('guild_members').select('pseudo, created_at').order('created_at', { ascending: false }).limit(5),
                // (sanctions déjà récupérées ci-dessus, on réutilise)
                Promise.resolve(null)
            ]);

            var stats = {
                members:   memCount.count || 0,
                liveEvents: (statusRows.data || []).filter(function (s) { return s.is_active; }).length,
                liveEventNames: (statusRows.data || []).filter(function (s) { return s.is_active; }).map(function (s) { return prettyEventName(s.event_name); }),
                gloryTotal: (gloryRows.data || []).reduce(function (a, r) { return a + (r.score || 0); }, 0),
                sanctions: (sanctionsRows.data || []).length
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
            var initials = window.RAD.avatarInit(m.name);
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
                statTile(t('overview_s_members'), fmt(stats.members), null, 'ph-users', false, '') +
                statTile(t('overview_s_events'), String(stats.liveEvents), null, 'ph-sword', stats.liveEvents > 0, liveEventsMeta) +
                statTile(t('overview_s_glory'), formatBigNumber(stats.gloryTotal), 'up', 'ph-trophy', false, t('overview_s_glory_meta')) +
                statTile(t('overview_s_sanctions'), String(stats.sanctions), stats.sanctions > 0 ? 'down' : null, 'ph-warning-octagon', false, '') +
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
        if (notifSlot && window.RAD_PUSH) window.RAD_PUSH.mount(notifSlot);

        startCountdownTicker();
    }

    function renderUpcomingCard(upcoming) {
        if (!upcoming || !upcoming.length) {
            return '<div class="gm-empty"><i class="ph-duotone ph-calendar-x gm-icon"></i>' +
                '<div class="gm-empty-title">' + t('overview_no_upcoming') + '</div></div>';
        }
        var html = '<div class="gm-card gm-card-padded gm-col" style="gap:.75rem;">';
        upcoming.forEach(function (u, i) {
            var isLast = i === upcoming.length - 1;
            html +=
                '<div class="gm-row" style="gap:.75rem; padding:.4rem 0;' +
                    (!isLast ? ' border-bottom: 1px solid var(--border-soft); padding-bottom: .85rem;' : '') + '">' +
                    '<div style="width:36px; height:36px; border-radius:9px; background: var(--accent-soft); color: var(--accent); display:flex; align-items:center; justify-content:center; flex-shrink:0;">' +
                        '<i class="ph ph-calendar-dot"></i>' +
                    '</div>' +
                    '<div class="gm-grow">' +
                        '<div style="font-size:.9rem; font-weight:600;">' + esc(u.name) + '</div>' +
                        '<div class="gm-dim" style="font-size:.78rem;">' + esc(window.RAD.formatDateTimeUTC(u.when)) + '</div>' +
                    '</div>' +
                    '<span class="gm-chip gm-chip-accent gm-countdown gm-mono" data-deadline="' + esc(u.when) + '">' + esc(formatCountdown(u.when)) + '</span>' +
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

    function statTile(label, value, trend, icon, accent, meta) {
        return '<div class="gm-stat-tile">' +
            '<div class="gm-stat-tile-label">' +
                '<i class="ph ' + icon + '" style="color:' + (accent ? 'var(--accent)' : 'var(--fg-dim)') + ';"></i>' +
                esc(label) +
            '</div>' +
            '<div class="gm-stat-tile-value">' + esc(value) + '</div>' +
            (meta || trend
                ? '<div class="gm-stat-tile-meta' + (trend === 'up' ? ' gm-up' : trend === 'down' ? ' gm-down' : '') + '">' +
                    (trend === 'up' ? '<i class="ph ph-trend-up"></i>' : '') +
                    (trend === 'down' ? '<i class="ph ph-trend-down"></i>' : '') +
                    esc(meta || '') +
                  '</div>'
                : '') +
        '</div>';
    }

    function renderActivityCard(activity) {
        if (!activity.length) {
            return '<div class="gm-empty"><i class="ph-duotone ph-clock-counter-clockwise gm-icon"></i>' +
                '<div class="gm-empty-title">' + t('overview_no_activity') + '</div></div>';
        }
        var html = '<div class="gm-card gm-card-padded gm-col" style="gap:.75rem;">';
        activity.forEach(function (a, i) {
            var isLast = i === activity.length - 1;
            html +=
                '<div class="gm-row" style="gap:.75rem; padding:.4rem 0;' +
                    (!isLast ? ' border-bottom: 1px solid var(--border-soft); padding-bottom: .85rem;' : '') + '">' +
                    '<div style="width:36px; height:36px; border-radius:9px; background: var(--' + a.color + '-soft); color: var(--' + a.color + '); display:flex; align-items:center; justify-content:center; flex-shrink:0;">' +
                        '<i class="ph ' + a.icon + '"></i>' +
                    '</div>' +
                    '<div class="gm-grow">' +
                        '<div style="font-size:.9rem; font-weight:500;">' + esc(a.text) + '</div>' +
                        '<div class="gm-dim" style="font-size:.78rem;">' + relativeTime(a.when) + '</div>' +
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
                var initials = window.RAD.avatarInit(m.name);
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
                    await window.RAD.config.set('timezone_clocks', JSON.stringify(CLOCK_MEMBERS));
                    window.RAD.showToast(t('toast_clock_deleted'), 'info');
                    renderModalClocks();
                    renderTimezoneClocks(panel);
                });
            });
        }

        document.getElementById('gm-add-clock-btn').addEventListener('click', async function () {
            var nameInput = document.getElementById('gm-new-clock-name');
            var name = nameInput.value.trim();
            if (!name) {
                window.RAD.showToast(t('toast_clock_name_empty'), 'error');
                return;
            }

            var offsetSelect = document.getElementById('gm-new-clock-offset');
            var offset = parseFloat(offsetSelect.value);

            var colors = ['accent', 'info', 'success', 'warning', 'danger'];
            var color = colors[CLOCK_MEMBERS.length % colors.length];

            CLOCK_MEMBERS.push({ name: name, offset: offset, color: color });
            await window.RAD.config.set('timezone_clocks', JSON.stringify(CLOCK_MEMBERS));
            window.RAD.showToast(t('toast_clock_added'), 'success');
            nameInput.value = '';

            renderModalClocks();
            renderTimezoneClocks(panel);
        });

        renderModalClocks();
    }

})();
