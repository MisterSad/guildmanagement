/**
 * portal.js — Player Portal dashboard (rendered once a player signs in).
 * Desktop grid layout, collapses to a single column on mobile.
 * Sections: profile header, stat tiles, per-event progression charts
 * (native canvas, no external chart library), active event score
 * submission, power update and guild transfer.
 */
(function () {

    var t = function (k) { return (window.GM_I18N && window.GM_I18N.t) ? window.GM_I18N.t(k) : k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };

    var portalState = {
        player: null,       // { pseudo, guild, overall_power }
        sessions: [],       // active event sessions
        history: null,      // per-event history from get-history
        kpis: null,         // personal KPIs + guild positioning
        activeTab: 'dashboard',
        period: 'all',      // 'all' | '8w' | '4w' | '1w'
        chartsDrawn: false,
        badgesLoaded: false
    };

    // Period presets, in weeks. 'all' keeps everything.
    var PERIODS = [
        { key: 'all', label: 'All Time' },
        { key: '8w', label: '8 Weeks' },
        { key: '4w', label: '4 Weeks' },
        { key: '1w', label: '1 Week' }
    ];

    // Return only the history rows inside the selected period (weeks).
    function filterHistoryByPeriod(history) {
        var weeks = { all: null, '8w': 8, '4w': 4, '1w': 1 }[portalState.period];
        if (weeks === null) return history;

        var cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7 * weeks);

        var filtered = {};
        Object.keys(history || {}).forEach(function (key) {
            var list = (history[key].history || []).filter(function (h) {
                if (!h.week_start) return true; // keep rows without a week (session-only)
                var d = new Date(h.week_start + 'T00:00:00');
                return !isNaN(d.getTime()) && d >= cutoff;
            });
            var attended = list.filter(function (h) { return h.participated || h.sub_present; }).length;
            filtered[key] = {
                count: list.length,
                attended: attended,
                rate: list.length > 0 ? Math.round((attended / list.length) * 100) : 0,
                has_score: !!history[key].has_score,
                history: list
            };
        });
        return filtered;
    }

    // ─── Invoke the member-portal edge function with the current session ────
    function invoke(action, payload) {
        var supabase = window.GM ? window.GM.db : null;
        if (!supabase) return Promise.resolve({ ok: false, error: 'no_client' });
        return supabase.functions.invoke('member-portal', {
            body: { action: action, payload: payload || {} }
        }).then(function (r) {
            var data = r && r.data;
            if (!data) return { ok: false, error: (r && r.error && r.error.message) || 'request_failed' };
            return data;
        }).catch(function () {
            return { ok: false, error: 'request_failed' };
        });
    }

    // ─── Load everything for the dashboard ─────────────────────────────────
    async function loadDashboard() {
        var root = document.getElementById('portal-dashboard-root');
        if (!root) return;
        root.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading your portal...</div></div>';

        var [profile, history, kpis] = await Promise.all([
            invoke('get-active-sessions', {}),
            invoke('get-history', {}),
            invoke('get-personal-kpis', {})
        ]);

        if (!profile.ok) {
            var rawErr = profile.error || 'unknown_error';
            var displayMsg = profile.message || rawErr;
            if (rawErr === 'Edge Function returned a non-2xx status code' || rawErr === 'unauthorized' || rawErr === 'player_not_found') {
                displayMsg = 'Session expired or player account not active. Please reconnect.';
            }
            root.innerHTML =
                '<div class="gm-empty" style="padding: 3rem 1.5rem; text-align: center; max-width: 480px; margin: 2rem auto; background: var(--bg-1); border-radius: var(--radius-xl); border: 1px solid var(--border-soft);">' +
                    '<i class="ph ph-warning-circle gm-icon" style="font-size: 3rem; color: #ef4444; margin-bottom: 1rem; display: block;"></i>' +
                    '<div class="gm-empty-title" style="font-size: 1.25rem; font-weight: 700; color: var(--fg); margin-bottom: 0.5rem;">Unable to load your portal</div>' +
                    '<div class="gm-empty-sub" style="color: var(--fg-dim); font-size: 0.95rem; margin: 0 auto 1.5rem auto;">' + esc(displayMsg) + '</div>' +
                    '<div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">' +
                        '<button class="gm-btn gm-btn-primary" onclick="if(window.GM&&window.GM.logout){window.GM.logout();}else{localStorage.clear();location.reload();}"><i class="ph ph-sign-out"></i> Reconnect / Sign Out</button>' +
                        '<button class="gm-btn gm-btn-outline" onclick="window.location.reload()"><i class="ph ph-arrows-clockwise"></i> Retry</button>' +
                    '</div>' +
                '</div>';
            return;
        }

        portalState.player = {
            pseudo: profile.pseudo,
            guild: profile.guild,
            overall_power: profile.overall_power,
            timezone_offset: profile.timezone_offset != null ? profile.timezone_offset : null,
            glory: profile.glory != null ? profile.glory : null
        };
        portalState.sessions = profile.sessions || [];
        portalState.history = history.ok ? (history.events || {}) : null;
        portalState.kpis = kpis.ok ? kpis : null;
        portalState.chartsDrawn = false;

        renderDashboard();
    }

    // ─── Render the full dashboard (same DA as the guild shell) ───────────
    function renderDashboard() {
        var root = document.getElementById('portal-dashboard-root');
        if (!root) return;
        var p = portalState.player;
        var initials = window.GM.avatarInit(p.pseudo);

        var navItems = [
            { id: 'settings', icon: 'ph-cardholder', label: 'My Info' },
            { id: 'dashboard', icon: 'ph-chart-line-up', label: 'My Progress' },
            { id: 'challenges', icon: 'ph-target', label: 'Challenges' },
            { id: 'absence', icon: 'ph-user-minus', label: 'Absence' },
            { id: 'events', icon: 'ph-calendar-dots', label: 'Active Events' },
            { id: 'badges', icon: 'ph-trophy', label: 'Badges' }
        ];

        var navHtml = navItems.map(function (item) {
            var isActive = portalState.activeTab === item.id;
            return '<button class="gm-nav-item' + (isActive ? ' gm-active' : '') + '" data-portal-nav="' + item.id + '">' +
                        '<i class="ph ' + item.icon + '"></i>' +
                        '<span>' + esc(item.label) + '</span>' +
                    '</button>';
        }).join('');

        var html =
            '<div class="gm-shell portal-shell">' +

                // Sidebar (desktop)
                '<aside class="gm-sidebar">' +
                    '<div class="gm-sidebar-header">' +
                        '<div class="gm-sidebar-user-row">' +
                            '<div class="gm-user-avatar-ring">' +
                                '<div class="gm-user-avatar">' + esc(initials) + '</div>' +
                            '</div>' +
                            '<div class="gm-sidebar-user-info">' +
                                '<div class="gm-sidebar-user-name">' + esc(p.pseudo) + '</div>' +
                                '<div class="gm-sidebar-user-role">' + esc(p.guild) + ' &middot; Player</div>' +
                            '</div>' +
                            '<button class="gm-sidebar-logout" data-portal-exit title="Sign out">' +
                                '<i class="ph ph-sign-out"></i>' +
                            '</button>' +
                        '</div>' +
                    '</div>' +
                    '<nav class="gm-sidebar-nav">' +
                        '<div class="gm-nav-section-label">Player Portal</div>' +
                        navHtml +
                    '</nav>' +
                    '<div class="gm-sidebar-sub-card">' +
                        '<div class="gm-sub-card-badge-avatar"><i class="ph ph-crosshair"></i></div>' +
                        '<div style="font-size:.8rem; font-weight:700; color:var(--fg);">' + esc(p.guild) + '</div>' +
                        '<div style="font-size:.68rem; color:var(--fg-dim); margin-top:.25rem;">Foundation Galactic Frontier</div>' +
                    '</div>' +
                '</aside>' +

                // Main column
                '<div class="gm-main">' +
                    '<header class="gm-topbar">' +
                        '<div class="gm-topbar-mobile-brand">' +
                            '<div class="gm-brand-mark">' + esc(initials) + '</div>' +
                            '<div class="gm-topbar-title">Player Portal</div>' +
                        '</div>' +
                        '<div class="gm-topbar-actions">' +
                            '<button class="gm-sidebar-logout" data-portal-exit title="Sign out"><i class="ph ph-sign-out"></i></button>' +
                        '</div>' +
                    '</header>' +

                    '<div class="gm-content">' +
                        '<div class="gm-page">' +
                            '<div id="portal-panel-dashboard" class="gm-page portal-panel"></div>' +
                            '<div id="portal-panel-challenges" class="gm-page portal-panel hidden"></div>' +
                            '<div id="portal-panel-badges" class="gm-page portal-panel hidden"></div>' +
                            '<div id="portal-panel-events" class="gm-page portal-panel hidden"></div>' +
                            '<div id="portal-panel-absence" class="gm-page portal-panel hidden"></div>' +
                            '<div id="portal-panel-settings" class="gm-page portal-panel hidden"></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                // Bottom navigation (mobile)
                '<nav class="gm-bottom-nav">' +
                    '<div class="gm-bottom-nav-inner">' +
                        navItems.map(function (item) {
                            var isActive = portalState.activeTab === item.id;
                            return '<button class="gm-bottom-nav-item' + (isActive ? ' gm-active' : '') + '" data-portal-nav="' + item.id + '">' +
                                        '<i class="ph ' + item.icon + ' gm-icon"></i>' +
                                        '<span>' + esc(item.label) + '</span>' +
                                    '</button>';
                        }).join('') +
                    '</div>' +
                '</nav>' +
            '</div>';

        root.innerHTML = html;

        function gotoTab(tabId) {
            portalState.activeTab = tabId;
            root.querySelectorAll('[data-portal-nav]').forEach(function (b) {
                b.classList.toggle('gm-active', b.getAttribute('data-portal-nav') === tabId);
            });
            ['dashboard', 'challenges', 'badges', 'events', 'absence', 'settings'].forEach(function (name) {
                var panel = document.getElementById('portal-panel-' + name);
                if (panel) panel.classList.toggle('hidden', name !== portalState.activeTab);
            });
            if (portalState.activeTab === 'dashboard' && !portalState.chartsDrawn) {
                renderDashboardPanel();
            }
            if (portalState.activeTab === 'challenges') {
                renderChallengesPanel();
            }
            if (portalState.activeTab === 'badges' && !portalState.badgesLoaded) {
                renderBadgesPanel();
            }
            if (portalState.activeTab === 'absence') {
                renderAbsencePanel();
            }
        }

        root.querySelectorAll('[data-portal-nav]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                gotoTab(btn.getAttribute('data-portal-nav'));
            });
        });

        root.querySelectorAll('[data-portal-exit]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                localStorage.removeItem('gm_portal_session');
                window.GM.logout().then(function () {
                    var portalView = document.getElementById('player-portal-view');
                    var loginView = document.getElementById('login-view');
                    if (portalView) portalView.classList.add('hidden');
                    if (portalView) portalView.classList.remove('portal-connected');
                    if (loginView) loginView.classList.remove('hidden');
                }).catch(function () {
                    var portalView = document.getElementById('player-portal-view');
                    var loginView = document.getElementById('login-view');
                    if (portalView) portalView.classList.add('hidden');
                    if (portalView) portalView.classList.remove('portal-connected');
                    if (loginView) loginView.classList.remove('hidden');
                });
            });
        });

        renderDashboardPanel();
        renderBadgesPanel();
        renderEventsPanel();
        renderSettingsPanel();
    }

    // ─── Panel 1: My Progress (stat tiles + charts) ────────────────────────
    function renderDashboardPanel() {
        var panel = document.getElementById('portal-panel-dashboard');
        if (!panel) return;

        var hist = filterHistoryByPeriod(portalState.history);
        var keys = Object.keys(hist);
        var totalCount = 0, totalAttended = 0;
        keys.forEach(function (k) {
            totalCount += hist[k].count;
            totalAttended += hist[k].attended;
        });
        var overallRate = totalCount > 0 ? Math.round((totalAttended / totalCount) * 100) : 0;

        // ── Advanced personal KPIs (from gm_personal_kpis) ─────────────────
        var kpis = portalState.kpis;
        var kpiHtml = '';
        if (kpis && kpis.power) {
            var pw = kpis.power;
            var gl = kpis.glory || {};
            var pa = kpis.participation || {};

            var powerDelta = pw.guild_max > 0
                ? Math.round((pw.current / pw.guild_max) * 100)
                : 0;
            var gloryWeek = (gl.current_week != null) ? window.GM.formatNumber(gl.current_week) : '0';
            var gloryRankTxt = (gl.current_week != null) ? '#' + (gl.rank || '-') + ' in guild' : 'No score yet';
            var gloryPct = (gl.guild_max_week != null && gl.guild_max_week > 0)
                ? Math.round(((gl.current_week || 0) / gl.guild_max_week) * 100)
                : 0;
            var partVsGuild = (pa.guild_avg_rate != null)
                ? (pa.rate - pa.guild_avg_rate)
                : 0;
            var partVsTxt = (pa.guild_avg_rate != null)
                ? (partVsGuild >= 0 ? '+' : '') + partVsGuild + '% vs guild avg'
                : 'No data';

            kpiHtml =
                '<div class="portal-kpi-grid">' +
                    '<div class="portal-kpi-card portal-kpi-power">' +
                        '<div class="portal-kpi-icon"><i class="ph ph-sword"></i></div>' +
                        '<div class="portal-kpi-value">' + esc(window.GM.formatPower(pw.current)) + '</div>' +
                        '<div class="portal-kpi-label">Combat Power</div>' +
                        '<div class="portal-kpi-rank">#' + esc(pw.rank || '-') + ' of ' + esc(pw.members || '-') + ' members</div>' +
                        '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + esc(powerDelta) + '%;"></div></div>' +
                        '<div class="portal-kpi-sub">Top ' + esc(pw.percentile != null ? pw.percentile : 0) + '% &middot; ' + esc(powerDelta) + '% of guild max</div>' +
                    '</div>' +
                    '<div class="portal-kpi-card portal-kpi-glory">' +
                        '<div class="portal-kpi-icon"><i class="ph ph-trophy"></i></div>' +
                        '<div class="portal-kpi-value">' + esc(gloryWeek) + '</div>' +
                        '<div class="portal-kpi-label">Glory this week</div>' +
                        '<div class="portal-kpi-rank">' + esc(gloryRankTxt) + '</div>' +
                        '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + esc(gloryPct) + '%;"></div></div>' +
                        '<div class="portal-kpi-sub">Best ever: ' + esc(gl.best_ever != null ? window.GM.formatNumber(gl.best_ever) : '-') + '</div>' +
                    '</div>' +
                    '<div class="portal-kpi-card portal-kpi-part">' +
                        '<div class="portal-kpi-icon"><i class="ph ph-calendar-check"></i></div>' +
                        '<div class="portal-kpi-value">' + esc(pa.rate != null ? pa.rate + '%' : '0%') + '</div>' +
                        '<div class="portal-kpi-label">Attendance rate</div>' +
                        '<div class="portal-kpi-rank">' + esc(pa.attended || 0) + '/' + esc(pa.total || 0) + ' events</div>' +
                        '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + esc(pa.rate || 0) + '%;"></div></div>' +
                        '<div class="portal-kpi-sub">' + esc(partVsTxt) + '</div>' +
                    '</div>' +
                    '<div class="portal-kpi-card portal-kpi-tenure">' +
                        '<div class="portal-kpi-icon"><i class="ph ph-hourglass"></i></div>' +
                        '<div class="portal-kpi-value">' + esc(kpis.days_in_guild != null ? kpis.days_in_guild : 0) + '</div>' +
                        '<div class="portal-kpi-label">Days in guild</div>' +
                        '<div class="portal-kpi-rank">' + esc(kpis.role || 'R1') + ' rank</div>' +
                        '<div class="portal-kpi-sub">&nbsp;</div>' +
                    '</div>' +
                '</div>';
        }

        var tilesHtml =
            '<div class="portal-stats">' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(totalCount) + '</div><div class="portal-stat-label">Events tracked</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(totalAttended) + '</div><div class="portal-stat-label">Participated</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(overallRate) + '%</div><div class="portal-stat-label">Attendance rate</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(window.GM.formatPower(portalState.player.overall_power)) + '</div><div class="portal-stat-label">Current power</div></div>' +
            '</div>';

        var periodHtml =
            '<div class="portal-period">' +
                '<span class="portal-period-label"><i class="ph ph-calendar"></i> Period</span>' +
                '<div class="portal-period-btns">' +
                    PERIODS.map(function (p) {
                        return '<button type="button" class="portal-period-btn' + (portalState.period === p.key ? ' active' : '') + '" data-period="' + p.key + '">' + esc(p.label) + '</button>';
                    }).join('') +
                '</div>' +
            '</div>';

        var chartsHtml = '';
        var chartKeys = keys.filter(function (k) { return hist[k].has_score; });

        if (chartKeys.length === 0) {
            chartsHtml = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-chart-bar gm-icon"></i><div class="gm-empty-title">No scored events for this period.</div><div class="gm-empty-sub">Progression charts appear for events with scores (SvS, GvG, Glory).</div></div>';
        } else {
            chartKeys.forEach(function (key, idx) {
                var ev = hist[key];
                chartsHtml += renderChartCard(key, ev, idx);
            });
        }

        // Events without scores get a compact participation-rate tile instead.
        // Fixed display order: Arms Race A, Arms Race B, then DTR, then the rest.
        var tilesHtml2 = '';
        var tileKeys = keys.filter(function (k) { return !hist[k].has_score; });
        var tileOrder = ['ARMS RACE STAGE A', 'ARMS RACE STAGE B', 'DEFEND TRADE ROUTE'];
        var orderedTiles = [];
        tileOrder.forEach(function (pref) {
            var i = tileKeys.indexOf(pref);
            if (i !== -1) {
                orderedTiles.push(tileKeys[i]);
                tileKeys.splice(i, 1);
            }
        });
        orderedTiles = orderedTiles.concat(tileKeys);

        if (orderedTiles.length > 0) {
            tilesHtml2 =
                '<div class="portal-participation-grid">' +
                    orderedTiles.map(function (key) {
                        return renderParticipationTile(key, hist[key]);
                    }).join('') +
                '</div>';
        }

        panel.innerHTML =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">My Progress</h1>' +
                    '<p class="gm-page-subtitle">Your participation across every guild event type</p>' +
                '</div>' +
                periodHtml +
            '</header>' +
            kpiHtml +
            tilesHtml +
            tilesHtml2 +
            '<div class="portal-charts-grid">' + chartsHtml + '</div>';

        // Period selector wiring
        panel.querySelectorAll('.portal-period-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                portalState.period = btn.getAttribute('data-period');
                renderDashboardPanel();
            });
        });

        // Draw charts after insertion
        portalState.chartsDrawn = true;
        window.requestAnimationFrame(function () {
            chartKeys.forEach(function (key, idx) {
                drawChart(key, hist[key], idx);
            });
        });
    }

    // ─── Chart card (canvas bar chart per event type) ──────────────────────
    // Event color is used only as a decorative accent strip; the card itself
    // keeps the dark neutral surface so the canvas and text stay high-contrast.
    function eventAccent(eventKey) {
        var lower = String(eventKey).toLowerCase();
        if (lower.indexOf('svs') !== -1) return '#a3e635';
        if (lower.indexOf('gvg') !== -1) return '#fb7185';
        if (lower.indexOf('shadowfront') !== -1) return '#c4b5fd';
        if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return '#22d3ee';
        if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return '#fbbf24';
        if (lower.indexOf('glory') !== -1) return '#34d399';
        return '#94a3b8';
    }

    function renderChartCard(eventKey, ev, idx) {
        var icon = window.GM.getEventIcon(eventKey);
        var accent = eventAccent(eventKey);
        var anyScore = (ev.history || []).some(function (h) { return (h.score || 0) > 0; });

        // History list: score per session, nothing about attendance.
        var historyHtml = '';
        (ev.history || []).slice(0, 8).forEach(function (h) {
            var label = h.week_start || h.session_id || '?';
            var scoreText = anyScore ? window.GM.formatNumber(h.score || 0) : '—';
            historyHtml +=
                '<div class="portal-chart-row">' +
                    '<span class="portal-chart-row-label">' + esc(String(label).slice(0, 10)) + '</span>' +
                    '<span class="portal-chart-row-score">' + esc(scoreText) + '</span>' +
                '</div>';
        });

        return '<div class="portal-chart-card">' +
                    '<div class="portal-chart-accent" style="background:' + accent + ';"></div>' +
                    '<div class="portal-chart-head">' +
                        '<div class="portal-chart-title"><i class="ph ' + icon + '" style="color:' + accent + ';"></i> ' + esc(eventKey) + '</div>' +
                        '<div class="portal-chart-meta"><i class="ph ph-chart-line-up"></i> Score evolution</div>' +
                    '</div>' +
                    '<canvas class="portal-chart-canvas" data-chart-key="' + esc(eventKey) + '" data-chart-idx="' + idx + '" width="1200" height="180"></canvas>' +
                    '<div class="portal-chart-list">' + historyHtml + '</div>' +
                '</div>';
    }

    // ─── Participation tile for events without scores ──────────────────────
    function renderParticipationTile(eventKey, ev) {
        var icon = window.GM.getEventIcon(eventKey);
        var accent = eventAccent(eventKey);
        var attended = ev.attended || 0;

        var recentBadges = '';
        (ev.history || []).slice(0, 4).forEach(function (h) {
            recentBadges += h.participated || h.sub_present
                ? '<span class="portal-badge" style="background:rgba(52,211,153,0.18); color:#34d399; border-color:rgba(52,211,153,0.45);">P</span>'
                : (h.excused ? '<span class="portal-badge" style="background:rgba(251,191,36,0.15); color:#fbbf24; border-color:rgba(251,191,36,0.45);">E</span>'
                   : '<span class="portal-badge" style="background:rgba(248,113,113,0.15); color:#f87171; border-color:rgba(248,113,113,0.45);">A</span>');
        });

        return '<div class="portal-participation-tile">' +
                    '<div class="portal-chart-accent" style="background:' + accent + ';"></div>' +
                    '<div class="portal-participation-body">' +
                        '<div class="portal-chart-title"><i class="ph ' + icon + '" style="color:' + accent + ';"></i> ' + esc(eventKey) + '</div>' +
                        '<div class="portal-participation-rate">' + esc(ev.rate) + '%</div>' +
                        '<div class="portal-participation-sub">' + esc(attended) + '/' + esc(ev.count) + ' attended</div>' +
                        '<div class="portal-participation-badges">' + recentBadges + '</div>' +
                    '</div>' +
                '</div>';
    }

    // ─── Native canvas line chart: score evolution over time ──────────────
    // The curve follows the player's score per session; no attendance colors.
    function drawChart(eventKey, ev, idx) {
        var canvas = document.querySelector('.portal-chart-canvas[data-chart-idx="' + idx + '"]');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Chronological order (oldest first) for the curve.
        var list = (ev.history || []).slice(0, 30).slice().reverse();
        var points = list
            .map(function (h, i) { return { x: i, y: h.score || 0, label: (h.week_start || h.session_id || '').toString().slice(5, 10) }; })
            .filter(function (p) { return p.y > 0; }); // only scored sessions shape the curve

        if (list.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = '14px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No data', w / 2, h / 2);
            return;
        }

        var padL = 46, padR = 14, padT = 20, padB = 28;
        var chartW = w - padL - padR;
        var chartH = h - padT - padB;
        var baseY = padT + chartH;

        var maxScore = 1;
        points.forEach(function (p) { if (p.y > maxScore) maxScore = p.y; });

        // Horizontal gridlines (4 steps) with score labels on the left axis
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'right';
        for (var g = 0; g <= 4; g++) {
            var gy = padT + chartH - (chartH * g / 4);
            ctx.strokeStyle = g === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padL, gy + 0.5);
            ctx.lineTo(w - padR, gy + 0.5);
            ctx.stroke();

            var val = Math.round(maxScore * g / 4);
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillText(window.GM.formatNumber(val), padL - 6, gy + 3);
        }

        if (points.length === 0) {
            // No scores in this period: flat empty chart with a clear message.
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = '700 13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No scores recorded in this period', w / 2, padT + chartH / 2 - 6);
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '11px Inter, sans-serif';
            ctx.fillText('Scores appear once they are submitted', w / 2, padT + chartH / 2 + 14);

            list.forEach(function (h, i) {
                var x = padL + (chartW * i / Math.max(1, list.length - 1));
                var label = (h.week_start || h.session_id || '').toString().slice(5, 10);
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.font = '11px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(label, x, padT + chartH + 17);
            });
            return;
        }

        // X positions map every session (including unscored ones) so the
        // curve stays aligned with the timeline.
        var xFor = function (i) { return padL + (chartW * i / Math.max(1, list.length - 1)); };
        var yFor = function (val) { return baseY - (chartH * (val / maxScore)); };

        // Area fill under the curve
        var grad = ctx.createLinearGradient(0, padT, 0, baseY);
        grad.addColorStop(0, 'rgba(52,211,153,0.28)');
        grad.addColorStop(1, 'rgba(52,211,153,0.02)');

        ctx.beginPath();
        points.forEach(function (p, i) {
            var x = xFor(p.x), y = yFor(p.y);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        if (points.length > 1) {
            ctx.lineTo(xFor(points[points.length - 1].x), baseY);
            ctx.lineTo(xFor(points[0].x), baseY);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();
        }

        // The score line itself
        ctx.beginPath();
        points.forEach(function (p, i) {
            var x = xFor(p.x), y = yFor(p.y);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        // Point markers with score values above them
        points.forEach(function (p) {
            var x = xFor(p.x), y = yFor(p.y);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#34d399';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.font = '700 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(window.GM.formatNumber(p.y), x, y - 8);
        });

        // Date labels below the axis
        list.forEach(function (h, i) {
            var x = xFor(i);
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText((h.week_start || h.session_id || '').toString().slice(5, 10), x, padT + chartH + 17);
        });
    }

    // ─── Panel: Weekly challenges + season progression ─────────────────────
    function renderChallengesPanel() {
        var panel = document.getElementById('portal-panel-challenges');
        if (!panel) return;
        panel.innerHTML =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">Challenges</h1>' +
                    '<p class="gm-page-subtitle">Weekly goals and your season progress</p>' +
                '</div>' +
            '</header>' +
            '<div id="portal-challenges-body"><div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading challenges...</div></div></div>';
        loadChallengesPanel();
    }

    function renderChallengeCard(challenge) {
        var cls = challenge.done ? 'portal-challenge done' : 'portal-challenge';
        var pct = challenge.target > 0 ? Math.min(100, Math.round(challenge.progress / challenge.target * 100)) : 0;
        return '<div class="' + cls + '">' +
                    '<div class="portal-challenge-icon"><i class="ph ' + challenge.icon + '"></i></div>' +
                    '<div class="portal-challenge-info">' +
                        '<div class="portal-challenge-name">' + esc(challenge.label) + '</div>' +
                        '<div class="portal-challenge-progress"><div class="portal-challenge-progress-fill" style="width:' + pct + '%; background:' + (challenge.done ? 'var(--success)' : 'var(--accent)') + ';"></div></div>' +
                    '</div>' +
                    '<div class="portal-challenge-state">' +
                        (challenge.done ? '<i class="ph ph-check-circle" style="color:var(--success);"></i>' : '<span class="portal-challenge-count">' + challenge.progress + '/' + challenge.target + '</span>') +
                    '</div>' +
                '</div>';
    }

    async function loadChallengesPanel() {
        var body = document.getElementById('portal-challenges-body');
        if (!body) return;
        var res = await invoke('get-weekly-challenges', {});
        if (!res.ok) {
            body.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load challenges.</div><div class="gm-empty-sub">' + esc(res.error || 'unknown error') + '</div></div>';
            return;
        }

        var levelMeta = {
            'None': { label: 'No season rank yet', color: 'var(--fg-dim)' },
            'Bronze': { label: 'Bronze season', color: '#cd7f32' },
            'Silver': { label: 'Silver season', color: '#c0c0c0' },
            'Gold': { label: 'Gold season', color: '#ffd700' }
        }[res.season.level] || { label: res.season.level, color: 'var(--accent)' };

        var cards = res.challenges.map(renderChallengeCard).join('');

        body.innerHTML =
            '<div class="portal-challenges-summary">' +
                '<div class="portal-challenges-summary-item"><span class="portal-challenges-summary-value">' + res.completed + '/' + res.total + '</span><span class="portal-challenges-summary-label">challenges done this week</span></div>' +
                '<div class="portal-challenges-summary-item"><span class="portal-challenges-summary-value" style="color:' + levelMeta.color + ';">' + res.season.events + '</span><span class="portal-challenges-summary-label">events over the season</span></div>' +
                '<div class="portal-challenges-summary-item"><span class="portal-challenges-summary-value" style="color:' + levelMeta.color + ';">' + levelMeta.label + '</span><span class="portal-challenges-summary-label">season</span></div>' +
            '</div>' +
            '<div class="portal-challenge-list">' + cards + '</div>';
    }

    // ─── Panel: Badges (gamification) ─────────────────────────────────────
    function renderBadgesPanel() {
        var panel = document.getElementById('portal-panel-badges');
        if (!panel) return;
        panel.innerHTML =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">Badges</h1>' +
                    '<p class="gm-page-subtitle">Achievements that unlock as you grow in the guild</p>' +
                '</div>' +
            '</header>' +
            '<div id="portal-badges-body"><div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading badges...</div></div></div>';
        loadBadgesPanel();
    }

    function formatBadgeCurrent(badge) {
        if (badge.category === 'rank') return 'R' + badge.current;
        if (badge.category === 'tenure') return window.GM.formatNumber(badge.current) + 'd';
        if (badge.category === 'power') return window.GM.formatPower(badge.current);
        if (badge.category === 'glory') return window.GM.formatNumber(badge.current);
        return window.GM.formatNumber(badge.current) + ' evts';
    }

    function formatBadgeTarget(badge) {
        if (badge.category === 'rank') return 'R' + badge.target;
        if (badge.category === 'tenure') return window.GM.formatNumber(badge.target) + 'd';
        if (badge.category === 'power') return window.GM.formatPower(badge.target);
        if (badge.category === 'glory') return window.GM.formatNumber(badge.target);
    }

    function renderBadgeCard(badge) {
        var cls = badge.earned ? 'portal-badge-card earned' : 'portal-badge-card locked';
        var iconCls = badge.earned ? 'portal-badge-icon' : 'portal-badge-icon dim';
        var stateHtml = badge.earned
            ? '<div class="portal-badge-state"><i class="ph ph-check-circle"></i> Unlocked</div>'
            : '<div class="portal-badge-state"><i class="ph ph-lock-key"></i> Locked</div>';

        var progressHtml = badge.earned
            ? '<div class="portal-badge-progress"><div class="portal-badge-progress-fill" style="width:100%; background:' + badge.color + ';"></div></div>'
            : '<div class="portal-badge-progress"><div class="portal-badge-progress-fill" style="width:' + badge.progress + '%; background:' + badge.color + ';"></div></div>';

        var metricHtml = badge.earned ? '' :
            '<div class="portal-badge-metric"><span>' + esc(formatBadgeCurrent(badge)) + '</span><span class="portal-badge-metric-sep">/</span><span>' + esc(formatBadgeTarget(badge)) + '</span></div>';

        return '<div class="' + cls + '">' +
                    '<div class="' + iconCls + '" style="color:' + badge.color + ';' + (badge.earned ? ' border-color:' + badge.color + '; box-shadow:0 0 18px ' + badge.color + '55;' : '') + '">' +
                        '<i class="ph ' + badge.icon + '"></i>' +
                    '</div>' +
                    '<div class="portal-badge-name">' + esc(badge.name) + '</div>' +
                    '<div class="portal-badge-desc">' + esc(badge.desc) + '</div>' +
                    progressHtml +
                    metricHtml +
                    stateHtml +
                '</div>';
    }

    function renderBadgesBody(data) {
        var body = document.getElementById('portal-badges-body');
        if (!body) return;

        var summary =
            '<div class="portal-badges-summary">' +
                '<div class="portal-badges-summary-item"><span class="portal-badges-summary-value">' + data.earned + '</span><span class="portal-badges-summary-label">of ' + data.total + ' badges earned</span></div>' +
                '<div class="portal-badges-summary-item"><span class="portal-badges-summary-value">' + data.categories.length + '</span><span class="portal-badges-summary-label">achievement tracks</span></div>' +
            '</div>';

        var sections = data.categories.map(function (cat) {
            var cards = cat.badges.map(renderBadgeCard).join('');
            return '<div class="portal-badge-section">' +
                        '<div class="portal-badge-section-title"><i class="ph ' + cat.icon + '" style="color:' + cat.color + ';"></i> ' + esc(cat.label) + '</div>' +
                        '<div class="portal-badge-grid">' + cards + '</div>' +
                    '</div>';
        }).join('');

        body.innerHTML = summary + sections;
    }

    async function loadBadgesPanel() {
        var body = document.getElementById('portal-badges-body');
        if (!body) return;

        var res = await invoke('get-badges', {});
        if (!res.ok) {
            body.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load your badges.</div><div class="gm-empty-sub">' + esc(res.error || 'unknown error') + '</div></div>';
            return;
        }

        var data = window.GM_BADGES.computeBadges({
            role: res.role,
            created_at: res.created_at,
            overall_power: res.overall_power,
            attended: res.attended,
            glory_best: res.glory_best
        });
        portalState.badgesLoaded = true;
        renderBadgesBody(data);
    }

    // ─── Panel 2: Active Events (score submission) ─────────────────────────
    function renderEventsPanel() {
        var panel = document.getElementById('portal-panel-events');
        if (!panel) return;

        var sessions = portalState.sessions || [];
        var submittedCount = sessions.filter(function (s) { return s.current_data && s.current_data.is_pending; }).length;
        var doneCount = sessions.filter(function (s) { return s.current_data && s.current_data.is_pending; }).length;

        var headerHtml =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">Active Events</h1>' +
                    '<p class="gm-page-subtitle">Tell the officers you took part and submit your scores</p>' +
                '</div>' +
            '</header>';

        if (!sessions || sessions.length === 0) {
            panel.innerHTML = headerHtml + '<div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-calendar-blank gm-icon"></i><div class="gm-empty-title">No active events right now.</div><div class="gm-empty-sub">When your guild starts an event, it will show up here for you to fill in.</div></div>';
            return;
        }

        var summaryHtml =
            '<div class="portal-events-summary">' +
                '<div class="portal-events-summary-item"><span class="portal-events-summary-value">' + sessions.length + '</span><span class="portal-events-summary-label">Active events</span></div>' +
                '<div class="portal-events-summary-item"><span class="portal-events-summary-value">' + (sessions.length - submittedCount) + '</span><span class="portal-events-summary-label">To submit</span></div>' +
                '<div class="portal-events-summary-item"><span class="portal-events-summary-value">' + submittedCount + '</span><span class="portal-events-summary-label">Submitted</span></div>' +
            '</div>';

        var html = '';
        sessions.forEach(function (sess) {
            html += renderEventCard(sess);
        });
        panel.innerHTML = headerHtml + summaryHtml + '<div class="portal-events-grid">' + html + '</div>';
        wireEventCards(panel);
    }

    function renderEventCard(sess) {
        var eventName = sess.event_name;
        var isSvsOrGvg = eventName === 'SvS' || eventName === 'GvG';
        var isDtr = eventName === 'Defend Trade Route';
        var isShadowfront = eventName === 'Shadowfront';
        var icon = window.GM.getEventIcon(eventName);
        var accent = eventAccent(eventName);

        var EVENTS_WITHOUT_SCORE = ['Defend Trade Route', 'Shadowfront', 'ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
        var hasScore = EVENTS_WITHOUT_SCORE.indexOf(eventName) === -1;

        var curr = sess.current_data || {};
        var isChecked = curr.participated > 0;
        var isLateChecked = !!curr.late;
        var isExcusedChecked = !!curr.excused;
        var isAppointedChecked = !!curr.appointed;
        var isPending = !!curr.is_pending;

        // Status pill
        var statusHtml = isPending
            ? '<span class="portal-status portal-status-pending"><i class="ph ph-hourglass"></i> Awaiting approval</span>'
            : '<span class="portal-status portal-status-todo"><i class="ph ph-pencil-line"></i> Not submitted yet</span>';

        var startLabel = sess.start_at ? window.GM.formatDateTimeUTC(sess.start_at) : '';

        // Main participation toggle
        var fieldsHtml =
            '<div class="portal-participation-box">' +
                '<label class="portal-participation-toggle">' +
                    '<div class="check-toggle">' +
                        '<input type="checkbox" class="participation-checkbox portal-check-participated" ' + (isChecked ? 'checked' : '') + '>' +
                        '<span class="check-slider"></span>' +
                    '</div>' +
                    '<div class="portal-participation-text">' +
                        '<span class="portal-participation-title">I participated in this event</span>' +
                        '<span class="portal-participation-hint">Mark this to tell the officers you were there</span>' +
                    '</div>' +
                '</label>' +
            '</div>';

        // Event-specific details (optional)
        var detailsHtml = '';
        if (isDtr || isShadowfront) {
            detailsHtml = '<div class="portal-details-label">Details (optional)</div><div class="portal-details-row">';
            if (isDtr) {
                detailsHtml +=
                    '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-appointed" ' + (isAppointedChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>I was appointed</span></label>';
            }
            if (isShadowfront) {
                detailsHtml +=
                    '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-late" ' + (isLateChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>I was late</span></label>' +
                    '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-excused" ' + (isExcusedChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>I was excused</span></label>';
            }
            detailsHtml += '</div>';
        }

        // Score inputs with live total
        var scoreHtml = '';
        if (hasScore) {
            scoreHtml = '<div class="portal-score-section">';
            if (isSvsOrGvg) {
                scoreHtml +=
                    '<div class="portal-score-fields">' +
                        '<div class="portal-field"><label class="portal-field-label">Days 1-5 score</label><input type="text" class="gm-input gm-input-sm portal-score-prep" value="' + esc(curr.score_prep != null ? curr.score_prep : '') + '" placeholder="e.g. 150000"></div>' +
                        '<div class="portal-field"><label class="portal-field-label">Day 6 score</label><input type="text" class="gm-input gm-input-sm portal-score-pvp" value="' + esc(curr.score_pvp != null ? curr.score_pvp : '') + '" placeholder="e.g. 50000"></div>' +
                    '</div>' +
                    '<div class="portal-score-total"><span class="portal-score-total-label">Total</span><span class="portal-score-total-value" data-total>0</span></div>';
            } else {
                scoreHtml +=
                    '<div class="portal-score-fields">' +
                        '<div class="portal-field"><label class="portal-field-label">Score</label><input type="text" class="gm-input gm-input-sm portal-score" value="' + esc(curr.score != null ? curr.score : '') + '" placeholder="e.g. 45000"></div>' +
                    '</div>' +
                    '<div class="portal-score-total"><span class="portal-score-total-label">Score</span><span class="portal-score-total-value" data-total>0</span></div>';
            }
            scoreHtml += '</div>';
        }

        var submitBtnHtml = isPending
            ? '<button type="button" class="gm-btn gm-btn-success gm-btn-sm portal-submit-event-btn" disabled><i class="ph ph-check-circle"></i><span>Submitted</span></button>'
            : '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm portal-submit-event-btn"><i class="ph ph-paper-plane-right"></i><span>Submit</span></button>';

        return '<div class="portal-event-card' + (isPending ? ' portal-event-submitted' : '') + '" data-event="' + esc(eventName) + '" data-session="' + esc(sess.session_id) + '">' +
                    '<div class="portal-event-head">' +
                        '<div class="portal-event-icon" style="background:' + accent + '1f; color:' + accent + ';"><i class="ph ' + icon + '"></i></div>' +
                        '<div class="portal-event-head-info">' +
                            '<div class="portal-event-title">' + esc(eventName) + '</div>' +
                            (startLabel ? '<div class="portal-event-sub"><i class="ph ph-clock"></i> ' + esc(startLabel) + '</div>' : '') +
                        '</div>' +
                        statusHtml +
                    '</div>' +
                    '<div class="portal-event-fields">' + fieldsHtml + detailsHtml + scoreHtml + '</div>' +
                    submitBtnHtml +
                '</div>';
    }

    function wireEventCards(panel) {
        panel.querySelectorAll('.portal-score, .portal-score-prep, .portal-score-pvp').forEach(function (inp) {
            window.GM.attachNumberFormatter(inp);
            inp.addEventListener('input', function () { updateCardTotal(inp.closest('.portal-event-card')); });
        });

        // Live total per card
        panel.querySelectorAll('.portal-event-card').forEach(function (card) {
            updateCardTotal(card);
        });

        function updateCardTotal(card) {
            var totalEl = card.querySelector('[data-total]');
            if (!totalEl) return;
            var prep = window.GM.parseNumber(card.querySelector('.portal-score-prep')?.value || '');
            var pvp = window.GM.parseNumber(card.querySelector('.portal-score-pvp')?.value || '');
            var single = window.GM.parseNumber(card.querySelector('.portal-score')?.value || '');
            var total = (prep || 0) + (pvp || 0) + (single || 0);
            totalEl.textContent = window.GM.formatNumber(total || 0);
        }

        panel.querySelectorAll('.portal-check-appointed').forEach(function (cb) {
            cb.addEventListener('change', function () {
                if (cb.checked) {
                    var card = cb.closest('.portal-event-card');
                    var partCb = card ? card.querySelector('.portal-check-participated') : null;
                    if (partCb) partCb.checked = true;
                }
            });
        });

        panel.querySelectorAll('.portal-submit-event-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var card = btn.closest('.portal-event-card');
                var eventName = card.getAttribute('data-event');
                var sessionId = card.getAttribute('data-session');

                var participated = card.querySelector('.portal-check-participated')?.checked;
                var appointed = card.querySelector('.portal-check-appointed')?.checked;
                var late = card.querySelector('.portal-check-late')?.checked;
                var excused = card.querySelector('.portal-check-excused')?.checked;

                var scoreVal = card.querySelector('.portal-score')?.value;
                var scorePrepVal = card.querySelector('.portal-score-prep')?.value;
                var scorePvpVal = card.querySelector('.portal-score-pvp')?.value;

                // Nothing to submit: participation unchecked and no scores
                if (!participated && !appointed && !late && !excused &&
                    !(scoreVal && scoreVal.replace(/[^0-9]/g, '')) &&
                    !(scorePrepVal && scorePrepVal.replace(/[^0-9]/g, '')) &&
                    !(scorePvpVal && scorePvpVal.replace(/[^0-9]/g, ''))) {
                    window.GM.showToast('Nothing to submit. Check participation or enter a score.', 'warning');
                    return;
                }

                var payload = {
                    event_name: eventName,
                    session_id: sessionId,
                    participated: participated,
                    appointed: appointed,
                    late: late,
                    excused: excused,
                    score: scoreVal !== undefined ? window.GM.parseNumber(scoreVal) : undefined,
                    score_prep: scorePrepVal !== undefined ? window.GM.parseNumber(scorePrepVal) : undefined,
                    score_pvp: scorePvpVal !== undefined ? window.GM.parseNumber(scorePvpVal) : undefined
                };

                btn.disabled = true;
                var span = btn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Submitting...';

                try {
                    var res = await invoke('submit-scores', payload);
                    if (!res.ok) throw new Error(res.error || 'submit_failed');
                    window.GM.showToast('Submitted! An officer will confirm it shortly.', 'success');
                    // Refresh the panel so statuses and the summary update
                    renderEventsPanel();
                } catch (err) {
                    console.error(err);
                    window.GM.showToast('Submission failed. Check your parameters.', 'error');
                    btn.disabled = false;
                    if (span) span.textContent = origText;
                }
            });
        });
    }

    // ─── Panel 3: My Info (power + glory + timezone + transfer) ────────────
    function renderSettingsPanel() {
        var panel = document.getElementById('portal-panel-settings');
        if (!panel) return;

        panel.innerHTML =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">My Info</h1>' +
                    '<p class="gm-page-subtitle">Manage your power, glory, timezone and guild transfer requests</p>' +
                '</div>' +
            '</header>' +
            '<div class="portal-settings-grid">' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-sword"></i> My Power<button class="gm-help-btn" data-help-id="help-portal-power" aria-label="Help: My Power"><i class="ph ph-info"></i></button></div>' +
                    '<div class="portal-row">' +
                        '<input type="text" id="portal-user-power" class="gm-input" placeholder="e.g. 80000000" value="' + esc(portalState.player.overall_power || '') + '">' +
                        '<button type="button" id="portal-update-power-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
                    '</div>' +
                '</div>' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-trophy"></i> My Glory<button class="gm-help-btn" data-help-id="help-portal-events" aria-label="Help: My Glory"><i class="ph ph-info"></i></button></div>' +
                    '<div class="portal-row">' +
                        '<input type="text" id="portal-user-glory" class="gm-input" placeholder="e.g. 50000" value="' + esc(portalState.player.glory != null ? portalState.player.glory : '') + '">' +
                        '<button type="button" id="portal-update-glory-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
                    '</div>' +
                    '<div class="portal-msg" id="portal-glory-msg"></div>' +
                    '<div class="portal-timezone-hint"><i class="ph ph-info"></i> Your weekly Glory score, used by officers for tracking and rewards.</div>' +
                '</div>' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-clock"></i> My Timezone<button class="gm-help-btn" data-help-id="help-portal-timezone" aria-label="Help: My Timezone"><i class="ph ph-info"></i></button></div>' +
                    '<div class="portal-row">' +
                        '<select id="portal-timezone-select" class="gm-input"></select>' +
                        '<button type="button" id="portal-timezone-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
                    '</div>' +
                    '<div class="portal-msg" id="portal-timezone-msg"></div>' +
                    '<div class="portal-timezone-hint"><i class="ph ph-info"></i> Helps officers plan events when most players are available.</div>' +
                '</div>' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-bell-ringing"></i> Notifications<button class="gm-help-btn" data-help-id="help-portal-dashboard" aria-label="Help: Notifications"><i class="ph ph-info"></i></button></div>' +
                    '<div class="portal-notif-hint"><i class="ph ph-info"></i> Choose which web-push reminders you want to receive.</div>' +
                    '<div class="portal-notif-options">' +
                        '<label class="portal-notif-opt"><input type="checkbox" id="portal-notif-events" value="events"><span><strong>Event reminders</strong><small>Starts, reminders and battle openings</small></span></label>' +
                        '<label class="portal-notif-opt"><input type="checkbox" id="portal-notif-glory" value="glory"><span><strong>Glory</strong><small>Weekly Glory tracking notices</small></span></label>' +
                        '<label class="portal-notif-opt"><input type="checkbox" id="portal-notif-challenges" value="challenges"><span><strong>Challenges</strong><small>Weekly challenges and season updates</small></span></label>' +
                    '</div>' +
                    '<div class="portal-row">' +
                        '<button type="button" id="portal-notif-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
                    '</div>' +
                    '<div class="portal-msg" id="portal-notif-msg"></div>' +
                '</div>' +

                '<div class="portal-card">' +
                    '<div class="portal-card-title"><i class="ph ph-swap"></i> Request Guild Transfer<button class="gm-help-btn" data-help-id="help-portal-transfer" aria-label="Help: Guild Transfer"><i class="ph ph-info"></i></button></div>' +
                    '<div class="portal-row">' +
                        '<select id="portal-transfer-select" class="gm-input"><option value="">Select Target Guild...</option></select>' +
                        '<button type="button" id="portal-transfer-btn" class="gm-btn gm-btn-primary gm-btn-sm" disabled><i class="ph ph-paper-plane-tilt"></i><span>Send</span></button>' +
                    '</div>' +
                    '<div id="portal-transfer-msg" class="portal-msg"></div>' +
                '</div>' +

            '</div>';

        // Power update
        var powerInput = document.getElementById('portal-user-power');
        var powerBtn = document.getElementById('portal-update-power-btn');
        if (powerInput) window.GM.attachNumberFormatter(powerInput);

        if (powerBtn) powerBtn.addEventListener('click', async function () {
            var powerVal = powerInput ? parseInt(String(powerInput.value).replace(/[^0-9]/g, ''), 10) : 0;
            if (isNaN(powerVal) || powerVal < 0) {
                window.GM.showToast('Please enter a valid power number.', 'error');
                return;
            }
            powerBtn.disabled = true;
            var span = powerBtn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Saving...';
            try {
                var res = await invoke('update-power', { power: powerVal });
                if (!res.ok) throw new Error(res.error || 'update_failed');
                portalState.player.overall_power = powerVal;
                var headerPower = document.querySelector('.portal-header-power-value');
                if (headerPower) headerPower.textContent = window.GM.formatPower(powerVal);
                window.GM.showToast('Your combat power has been updated!', 'success');
            } catch (err) {
                window.GM.showToast('Failed to update combat power: ' + err.message, 'error');
            } finally {
                powerBtn.disabled = false;
                if (span) span.textContent = origText;
            }
        });

        // Glory update
        var gloryInput = document.getElementById('portal-user-glory');
        var gloryBtn = document.getElementById('portal-update-glory-btn');
        var gloryMsg = document.getElementById('portal-glory-msg');
        if (gloryInput) window.GM.attachNumberFormatter(gloryInput);

        if (gloryBtn) gloryBtn.addEventListener('click', async function () {
            var gloryVal = gloryInput ? parseInt(String(gloryInput.value).replace(/[^0-9]/g, ''), 10) : 0;
            if (isNaN(gloryVal) || gloryVal < 0) {
                window.GM.showToast('Please enter a valid Glory number.', 'error');
                return;
            }
            gloryBtn.disabled = true;
            var span = gloryBtn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Saving...';
            try {
                var res = await invoke('update-glory', { glory: gloryVal });
                if (!res.ok) throw new Error(res.error || 'update_failed');
                portalState.player.glory = gloryVal;
                if (gloryMsg) {
                    gloryMsg.textContent = 'Glory saved. Your officers can now see your score.';
                    gloryMsg.style.color = 'var(--success)';
                    gloryMsg.style.display = 'block';
                }
                window.GM.showToast('Your Glory has been updated!', 'success');
            } catch (err) {
                if (gloryMsg) {
                    gloryMsg.textContent = 'Failed to save: ' + err.message;
                    gloryMsg.style.color = 'var(--danger)';
                    gloryMsg.style.display = 'block';
                }
            } finally {
                gloryBtn.disabled = false;
                if (span) span.textContent = origText;
            }
        });

        // Timezone
        var tzSelect = document.getElementById('portal-timezone-select');
        var tzBtn = document.getElementById('portal-timezone-btn');
        var tzMsg = document.getElementById('portal-timezone-msg');
        if (tzSelect) {
            var tzOptions = '';
            for (var o = -12; o <= 14; o++) {
                var label = 'UTC' + (o === 0 ? '' : (o > 0 ? '+' + o : o));
                tzOptions += '<option value="' + o + '">' + label + '</option>';
            }
            tzSelect.innerHTML = tzOptions;
            var currentTz = (portalState.player.timezone_offset != null) ? portalState.player.timezone_offset : null;
            if (currentTz != null) tzSelect.value = String(currentTz);
        }
        if (tzBtn && tzSelect) {
            tzBtn.addEventListener('click', async function () {
                var offset = parseInt(tzSelect.value, 10);
                if (isNaN(offset)) return;
                tzBtn.disabled = true;
                var span = tzBtn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Saving...';
                try {
                    var res = await invoke('update-timezone', { offset: offset });
                    if (!res.ok) throw new Error(res.error || 'update_failed');
                    portalState.player.timezone_offset = offset;
                    if (tzMsg) {
                        tzMsg.textContent = 'Timezone saved. Your officers can now see when you are available.';
                        tzMsg.style.color = 'var(--success)';
                        tzMsg.style.display = 'block';
                    }
                    window.GM.showToast('Timezone updated!', 'success');
                } catch (err) {
                    if (tzMsg) {
                        tzMsg.textContent = 'Failed to save: ' + err.message;
                        tzMsg.style.color = 'var(--danger)';
                        tzMsg.style.display = 'block';
                    }
                } finally {
                    tzBtn.disabled = false;
                    if (span) span.textContent = origText;
                }
            });
        }

        // Transfer
        var transferSelect = document.getElementById('portal-transfer-select');
        var transferBtn = document.getElementById('portal-transfer-btn');
        var transferMsg = document.getElementById('portal-transfer-msg');

        function setTransferMsg(msg, type) {
            if (!transferMsg) return;
            transferMsg.textContent = msg;
            transferMsg.style.color = type === 'error' ? 'var(--danger)' : 'var(--success)';
            transferMsg.style.display = 'block';
        }

        invoke('get-transfer-guilds', {}).then(function (res) {
            if (!res.ok) {
                transferSelect.innerHTML = '<option value="">Unable to load guilds</option>';
                return;
            }
            if (!res.guilds || res.guilds.length === 0) {
                transferSelect.innerHTML = '<option value="">No other guilds on this server</option>';
                return;
            }
            var opts = '<option value="">Select Target Guild...</option>';
            res.guilds.forEach(function (g) {
                var displayName = g.name ? g.name : g.id;
                opts += '<option value="' + esc(g.id) + '">' + esc(displayName) + '</option>';
            });
            transferSelect.innerHTML = opts;
        });

        if (transferSelect && transferBtn) {
            transferSelect.addEventListener('change', function () {
                transferBtn.disabled = !this.value;
            });
            transferBtn.addEventListener('click', async function () {
                var targetGuild = transferSelect.value;
                if (!targetGuild) return;
                transferBtn.disabled = true;
                transferSelect.disabled = true;
                var span = transferBtn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Sending...';
                transferMsg.style.display = 'none';
                try {
                    var res = await invoke('submit-transfer-request', { targetGuild: targetGuild });
                    if (!res.ok) {
                        var code = res.error || 'unknown';
                        if (code === 'already_pending') setTransferMsg('You already have a pending transfer request.', 'error');
                        else if (code === 'same_guild') setTransferMsg('You cannot transfer to your current guild.', 'error');
                        else setTransferMsg('Transfer request failed (' + code + ').', 'error');
                    } else {
                        setTransferMsg('Transfer request sent! Waiting for approval.', 'success');
                    }
                } catch (err) {
                    setTransferMsg('An error occurred.', 'error');
                } finally {
                    if (span) span.textContent = origText;
                    transferBtn.disabled = !transferSelect.value;
                    transferSelect.disabled = false;
                }
            });
        }

        // Notifications preferences
        var notifBtn = document.getElementById('portal-notif-btn');
        var notifMsg = document.getElementById('portal-notif-msg');
        var notifBoxes = ['events', 'glory', 'challenges'].map(function (k) {
            return document.getElementById('portal-notif-' + k);
        });

        function setNotifMsg(msg, type) {
            if (!notifMsg) return;
            notifMsg.textContent = msg;
            notifMsg.style.color = type === 'error' ? 'var(--danger)' : 'var(--success)';
            notifMsg.style.display = 'block';
        }

        // Load current preferences and tick the boxes.
        invoke('get-push-prefs', {}).then(function (res) {
            var types = (res.ok && res.event_types) ? res.event_types : ['events', 'glory', 'challenges'];
            notifBoxes.forEach(function (box) {
                if (box) box.checked = types.indexOf(box.value) !== -1;
            });
        });

        if (notifBtn) {
            notifBtn.addEventListener('click', async function () {
                var selected = notifBoxes.filter(function (b) { return b && b.checked; }).map(function (b) { return b.value; });
                if (selected.length === 0) {
                    setNotifMsg('Select at least one notification type.', 'error');
                    return;
                }
                notifBtn.disabled = true;
                var span = notifBtn.querySelector('span');
                var origText = span ? span.textContent : '';
                if (span) span.textContent = 'Saving...';
                notifMsg.style.display = 'none';
                try {
                    var res = await invoke('set-push-prefs', { event_types: selected });
                    if (!res.ok) {
                        setNotifMsg('Failed to save notification preferences (' + (res.error || 'unknown') + ').', 'error');
                    } else {
                        setNotifMsg('Notification preferences saved.', 'success');
                    }
                } catch (err) {
                    setNotifMsg('An error occurred.', 'error');
                } finally {
                    if (span) span.textContent = origText;
                    notifBtn.disabled = false;
                }
            });
        }
    }

    // ─── Panel: Absence declaration ────────────────────────────────────────
    function renderAbsencePanel() {
        var panel = document.getElementById('portal-panel-absence');
        if (!panel) return;

        panel.innerHTML =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">Absence</h1>' +
                    '<p class="gm-page-subtitle">Let your officers know you will be away or less active. This is visible to your guild admins.</p>' +
                '</div>' +
            '</header>' +
            '<div id="portal-absence-body"><div class="gm-empty" style="padding:2rem 0;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading...</div></div></div>';

        loadAbsencePanel();
    }

    async function loadAbsencePanel() {
        var body = document.getElementById('portal-absence-body');
        if (!body) return;

        var res = await invoke('get-absences', {});
        if (!res.ok) {
            body.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load your absences.</div></div>';
            return;
        }

        var absences = res.absences || [];
        var now = new Date();
        var hasActive = absences.some(function (a) {
            return new Date(a.end_date + 'T23:59:59') >= now && new Date(a.start_date + 'T00:00:00') <= now;
        });
        var hasUpcoming = absences.some(function (a) {
            return new Date(a.start_date + 'T00:00:00') > now;
        });

        // Declaration form
        var formHtml =
            '<div class="portal-card portal-absence-form">' +
                '<div class="portal-card-title"><i class="ph ph-calendar-plus"></i> Declare a period</div>' +
                '<div class="portal-absence-fields">' +
                    '<div class="portal-field"><label class="portal-field-label">Type</label>' +
                        '<select id="portal-absence-kind" class="gm-input">' +
                            '<option value="full">Full absence</option>' +
                            '<option value="reduced">Reduced activity</option>' +
                        '</select>' +
                    '</div>' +
                    '<div class="portal-field"><label class="portal-field-label">From</label>' +
                        '<input type="date" id="portal-absence-start" class="gm-input">' +
                    '</div>' +
                    '<div class="portal-field"><label class="portal-field-label">To</label>' +
                        '<input type="date" id="portal-absence-end" class="gm-input">' +
                    '</div>' +
                    '<div class="portal-field"><label class="portal-field-label">Note (optional)</label>' +
                        '<input type="text" id="portal-absence-note" class="gm-input" placeholder="e.g. exams, work, holidays" maxlength="120">' +
                    '</div>' +
                '</div>' +
                '<div id="portal-absence-msg" class="portal-msg"></div>' +
                '<button type="button" id="portal-absence-save-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
            '</div>';

        // Existing declarations
        var listHtml = '';
        if (absences.length === 0) {
            listHtml = '<div class="gm-empty" style="padding:1.5rem 0;"><i class="ph-duotone ph-calendar-blank gm-icon"></i><div class="gm-empty-title">No declared absences.</div></div>';
        } else {
            listHtml = '<div class="portal-absence-list">' + absences.map(function (a) {
                var start = new Date(a.start_date + 'T00:00:00');
                var end = new Date(a.end_date + 'T23:59:59');
                var status = end < now
                    ? '<span class="portal-absence-badge portal-absence-badge-past">Past</span>'
                    : (start > now ? '<span class="portal-absence-badge portal-absence-badge-upcoming">Upcoming</span>'
                       : '<span class="portal-absence-badge portal-absence-badge-active">Active</span>');
                var kindLabel = a.kind === 'reduced' ? 'Reduced activity' : 'Full absence';
                return '<div class="portal-absence-item" data-id="' + esc(a.id) + '">' +
                            '<div class="portal-absence-item-head">' +
                                '<div class="portal-absence-item-title"><i class="ph ' + (a.kind === 'reduced' ? 'ph-gauge' : 'ph-user-minus') + '"></i> ' + esc(kindLabel) + '</div>' +
                                status +
                            '</div>' +
                            '<div class="portal-absence-item-dates">' + esc(a.start_date) + ' → ' + esc(a.end_date) + '</div>' +
                            (a.note ? '<div class="portal-absence-item-note">' + esc(a.note) + '</div>' : '') +
                            '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm portal-absence-delete-btn" data-id="' + esc(a.id) + '"><i class="ph ph-trash"></i><span>Remove</span></button>' +
                        '</div>';
            }).join('') + '</div>';
        }

        var noticeHtml = hasActive || hasUpcoming
            ? '<div class="portal-absence-notice"><i class="ph ph-info"></i> Officers can see your declaration in the guild panel.</div>'
            : '';

        body.innerHTML = formHtml + '<div class="portal-absence-section-title">Your declarations</div>' + listHtml + noticeHtml;

        // Wire the form
        var kindEl = document.getElementById('portal-absence-kind');
        var startEl = document.getElementById('portal-absence-start');
        var endEl = document.getElementById('portal-absence-end');
        var noteEl = document.getElementById('portal-absence-note');
        var saveBtn = document.getElementById('portal-absence-save-btn');
        var msgEl = document.getElementById('portal-absence-msg');

        function setMsg(text, type) {
            if (!msgEl) return;
            msgEl.textContent = text;
            msgEl.style.color = type === 'error' ? 'var(--danger)' : 'var(--success)';
            msgEl.style.display = 'block';
        }

        if (saveBtn) saveBtn.addEventListener('click', async function () {
            var start = startEl.value;
            var end = endEl.value;
            if (!start || !end) {
                setMsg('Pick a start and an end date.', 'error');
                return;
            }
            if (end < start) {
                setMsg('The end date cannot be before the start date.', 'error');
                return;
            }
            saveBtn.disabled = true;
            var span = saveBtn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Saving...';
            try {
                var res = await invoke('set-absence', {
                    start_date: start,
                    end_date: end,
                    kind: kindEl.value,
                    note: noteEl.value.trim()
                });
                if (!res.ok) throw new Error(res.error || 'save_failed');
                setMsg('Absence declared. Your officers can now see it.', 'success');
                loadAbsencePanel();
            } catch (err) {
                setMsg('Failed to save: ' + err.message, 'error');
                saveBtn.disabled = false;
                if (span) span.textContent = origText;
            }
        });

        body.querySelectorAll('.portal-absence-delete-btn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
                btn.disabled = true;
                try {
                    var res = await invoke('delete-absence', { id: btn.getAttribute('data-id') });
                    if (!res.ok) throw new Error(res.error || 'delete_failed');
                    loadAbsencePanel();
                } catch (err) {
                    window.GM.showToast('Failed to remove: ' + err.message, 'error');
                    btn.disabled = false;
                }
            });
        });
    }

    // ─── Public API ────────────────────────────────────────────────────────
    window.GM_PORTAL = {
        loadDashboard: loadDashboard,
        renderDashboard: renderDashboard
    };

})();
