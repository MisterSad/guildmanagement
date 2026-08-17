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
        guildAverages: {},  // guild average military and event metrics
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
            overall_power: profile.overall_power || 0,
            tech_power: profile.tech_power || 0,
            champion_power: profile.champion_power || 0,
            crew_power: profile.crew_power || 0,
            flagship_power: profile.flagship_power || 0,
            fleet_rating: profile.fleet_rating || 0,
            glory_score: profile.glory_score || (profile.glory != null ? profile.glory : 0),
            metrics_updated_at: profile.metrics_updated_at || null,
            timezone_offset: profile.timezone_offset != null ? profile.timezone_offset : null,
            glory: profile.glory != null ? profile.glory : null
        };
        portalState.sessions = profile.sessions || [];
        portalState.history = history.ok ? (history.events || {}) : null;
        portalState.guildAverages = Object.assign({}, (kpis && kpis.guild_averages) || {}, (profile && profile.guild_averages) || {}, (history && history.guild_averages) || {});
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
        var player = portalState.player || {};
        var guildAvg = portalState.guildAverages || {};
        var density = window.GM.calculateCombatDensity ? window.GM.calculateCombatDensity(player) : 0;
        var residual = window.GM.calculateResidualPower ? window.GM.calculateResidualPower(player) : 0;
        var combativity = window.GM.calculateCombativity ? window.GM.calculateCombativity(player) : 0;

        var maxGuildPower = (kpis && kpis.power && kpis.power.guild_max) || (player.overall_power * 1.25) || 100000000;
        var playerRallyScore = window.GM.calculateRallyScore ? window.GM.calculateRallyScore(player) : 0;
        var estimatedMaxRally = Math.max(playerRallyScore, Math.round(maxGuildPower * 5.2));
        var rallyGrade = window.GM.calculateRallyGrade ? window.GM.calculateRallyGrade(player, estimatedMaxRally) : 100;

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
                        '<div class="portal-kpi-sub">Top ' + esc(pw.percentile != null ? pw.percentile : 0) + '% &middot; vs Avg: ' + esc(window.GM.formatPower(guildAvg.overall_power || pw.guild_avg || 0)) + '</div>' +
                    '</div>' +
                    '<div class="portal-kpi-card portal-kpi-glory">' +
                        '<div class="portal-kpi-icon"><i class="ph ph-trophy"></i></div>' +
                        '<div class="portal-kpi-value">' + esc(gloryWeek) + '</div>' +
                        '<div class="portal-kpi-label">Glory this week</div>' +
                        '<div class="portal-kpi-rank">' + esc(gloryRankTxt) + '</div>' +
                        '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + esc(gloryPct) + '%;"></div></div>' +
                        '<div class="portal-kpi-sub">Best: ' + esc(gl.best_ever != null ? window.GM.formatNumber(gl.best_ever) : '-') + ' &middot; Avg: ' + esc(window.GM.formatNumber(guildAvg.glory_score || gl.guild_avg_week || 0)) + '</div>' +
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
                        '<div class="portal-kpi-icon"><i class="ph ph-lightning"></i></div>' +
                        '<div class="portal-kpi-value" style="color:#fbbf24;">⚡ ' + esc(rallyGrade) + '/100</div>' +
                        '<div class="portal-kpi-label">Rally Grade</div>' +
                        '<div class="portal-kpi-rank">Combat Density: ' + density + '%</div>' +
                        '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + esc(rallyGrade) + '%; background:#fbbf24;"></div></div>' +
                        '<div class="portal-kpi-sub">Combativity: ' + combativity + 'x &middot; ' + esc(kpis.role || 'R1') + '</div>' +
                    '</div>' +
                '</div>';
        }

        var tilesHtml =
            '<div class="portal-stats">' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(totalCount) + '</div><div class="portal-stat-label">Events tracked</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(totalAttended) + '</div><div class="portal-stat-label">Participated</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(overallRate) + '%</div><div class="portal-stat-label">Attendance rate</div></div>' +
                '<div class="portal-stat"><div class="portal-stat-value">' + esc(window.GM.formatPower(player.overall_power)) + '</div><div class="portal-stat-label">Current power</div></div>' +
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

        function renderMilitaryTile(icon, label, playerVal, avgVal, color) {
            var pVal = Number(playerVal) || 0;
            var aVal = Number(avgVal) || 0;
            var deltaHtml = '';
            if (aVal > 0 && pVal > 0) {
                var diffPct = Math.round(((pVal - aVal) / aVal) * 1000) / 10;
                if (diffPct >= 0) {
                    deltaHtml = '<span class="gm-chip" style="font-size:0.68rem; padding:0.1rem 0.38rem; color:#6dd58c; background:rgba(109,213,140,0.14); border:1px solid rgba(109,213,140,0.25); border-radius:var(--md-sys-shape-corner-full, 9999px); white-space:nowrap;">+' + diffPct + '%</span>';
                } else {
                    deltaHtml = '<span class="gm-chip" style="font-size:0.68rem; padding:0.1rem 0.38rem; color:#ffe088; background:rgba(255,224,136,0.14); border:1px solid rgba(255,224,136,0.25); border-radius:var(--md-sys-shape-corner-full, 9999px); white-space:nowrap;">' + diffPct + '%</span>';
                }
            }
            var avgFormatted = aVal > 0 ? window.GM.formatPower(aVal) : (pVal > 0 ? window.GM.formatPower(pVal) : '0');
            return '<div class="portal-military-tile">' +
                        '<div class="portal-military-tile-header">' +
                            '<div class="portal-military-tile-title">' +
                                '<span class="portal-military-tile-icon">' + icon + '</span>' +
                                '<span class="portal-military-tile-label">' + esc(label) + '</span>' +
                            '</div>' +
                            '<div class="portal-military-tile-delta">' + deltaHtml + '</div>' +
                        '</div>' +
                        '<div class="portal-military-tile-value" style="color:' + color + ';">' + esc(window.GM.formatPower(pVal)) + '</div>' +
                        '<div class="portal-military-tile-footer">' +
                            '<span class="material-symbols-rounded">groups</span>' +
                            '<span class="portal-military-tile-avg-label">Guild Avg:</span>' +
                            '<span class="portal-military-tile-avg-val">' + esc(avgFormatted) + '</span>' +
                        '</div>' +
                    '</div>';
        }

        var tacticalBreakdownHtml =
            '<div class="portal-card" style="margin-bottom: 1.25rem; background: var(--md-sys-color-surface-container, #1e1f20); border: 1px solid var(--md-sys-color-outline-variant, rgba(255, 255, 255, 0.08)); border-radius: var(--md-sys-shape-corner-large, 16px); padding: 1.35rem; box-shadow: var(--md-sys-elevation-level1, 0 1px 3px rgba(0,0,0,0.2));">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.15rem; flex-wrap:wrap; gap:0.6rem;">' +
                    '<div style="display:flex; align-items:center; gap:0.55rem;">' +
                        '<span class="material-symbols-rounded" style="color:var(--md-sys-color-primary, #a8c7fa); font-size:1.5rem;">swords</span>' +
                        '<span style="font-weight:800; font-size:1.1rem; color:var(--md-sys-color-on-surface, #e3e3e3);">Military Force Breakdown &amp; Guild Benchmarks</span>' +
                    '</div>' +
                    '<div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">' +
                        '<span class="gm-chip" style="font-size:0.75rem; font-weight:700; color:#a8c7fa; background:rgba(168,199,250,0.12); border:1px solid rgba(168,199,250,0.25); border-radius:var(--md-sys-shape-corner-full);"><i class="ph ph-shield-check"></i> Density: ' + Math.min(100, Math.round(density)) + '%</span>' +
                        '<span class="gm-chip" style="font-size:0.75rem; font-weight:700; color:#6dd58c; background:rgba(109,213,140,0.12); border:1px solid rgba(109,213,140,0.25); border-radius:var(--md-sys-shape-corner-full);"><i class="ph ph-crosshair"></i> Combativity: ' + combativity + 'x</span>' +
                        '<span class="gm-chip" style="font-size:0.75rem; font-weight:700; color:#ffe088; background:rgba(255,224,136,0.12); border:1px solid rgba(255,224,136,0.25); border-radius:var(--md-sys-shape-corner-full);"><i class="ph ph-barricade"></i> Volatile: ' + esc(window.GM.formatPower(residual)) + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="portal-military-grid">' +
                    renderMilitaryTile('⚔️', 'Fleet Rating', player.fleet_rating, guildAvg.fleet_rating, '#a8c7fa') +
                    renderMilitaryTile('🔬', 'Tech Power', player.tech_power, guildAvg.tech_power, '#d0bcff') +
                    renderMilitaryTile('🚀', 'Flagship Power', player.flagship_power, guildAvg.flagship_power, '#ffe088') +
                    renderMilitaryTile('👑', 'Champions Power', player.champion_power, guildAvg.champion_power, '#f472b6') +
                    renderMilitaryTile('👥', 'Crew Power', player.crew_power, guildAvg.crew_power, '#70d7ff') +
                    renderMilitaryTile('🏆', 'Glory Score', (player.glory_score || player.glory), guildAvg.glory_score, '#6dd58c') +
                    renderMilitaryTile('🛡️', 'Total Power', player.overall_power, guildAvg.overall_power, '#e3e3e3') +
                '</div>' +
            '</div>';

        panel.innerHTML =
            '<header class="gm-page-header">' +
                '<div>' +
                    '<h1 class="gm-page-title">My Progress</h1>' +
                    '<p class="gm-page-subtitle">Your score progression, event performance, and guild benchmark comparison</p>' +
                '</div>' +
                periodHtml +
            '</header>' +
            kpiHtml +
            tilesHtml +
            tacticalBreakdownHtml +
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

    // ─── Format date to DD/MM/YY (JJ/MM/AA) format ─────────────────────────
    function formatPortalDateDDMMAA(h) {
        if (!h) return '';
        var raw = typeof h === 'string' ? h : (h.week_start || h.battle_date || h.start_at || h.date || h.session_id || '');
        if (!raw) return '';

        // 1. Direct YYYY-MM-DD pattern (e.g. 2026-08-10 or 2026-08-10T...)
        var ymdMatch = String(raw).match(/(\d{4})-(\d{2})-(\d{2})/);
        if (ymdMatch) {
            var y = ymdMatch[1].slice(-2);
            var m = ymdMatch[2];
            var d = ymdMatch[3];
            return d + '/' + m + '/' + y;
        }

        // 2. YYYYMMDD compact pattern (e.g. ARA-20260815, SF-20260815, DTR-20260815)
        var compactMatch = String(raw).match(/(\d{4})(\d{2})(\d{2})/);
        if (compactMatch) {
            var cy = compactMatch[1].slice(-2);
            var cm = compactMatch[2];
            var cd = compactMatch[3];
            return cd + '/' + cm + '/' + cy;
        }

        // 3. ISO Week pattern (e.g. SVS-2026-W33, GVG-2026-W33, 2026-W33)
        var weekMatch = String(raw).match(/(\d{4})-W(\d{2})/i);
        if (weekMatch) {
            var yr = parseInt(weekMatch[1], 10);
            var wk = parseInt(weekMatch[2], 10);
            var simple = new Date(Date.UTC(yr, 0, 1 + (wk - 1) * 7));
            var dayOfWeek = simple.getUTCDay();
            var isoMonday = new Date(simple);
            if (dayOfWeek <= 4) {
                isoMonday.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
            } else {
                isoMonday.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
            }
            var padW = function (n) { return n < 10 ? '0' + n : String(n); };
            return padW(isoMonday.getUTCDate()) + '/' + padW(isoMonday.getUTCMonth() + 1) + '/' + String(isoMonday.getUTCFullYear()).slice(-2);
        }

        // 4. Fallback: try JS Date parsing
        var dt = new Date(raw);
        if (!isNaN(dt.getTime())) {
            var padD = function (n) { return n < 10 ? '0' + n : String(n); };
            return padD(dt.getUTCDate()) + '/' + padD(dt.getUTCMonth() + 1) + '/' + String(dt.getUTCFullYear()).slice(-2);
        }

        return String(raw);
    }

    // ─── Chart card (canvas line chart per event type with Guild Average benchmark) ──
    function eventAccent(eventKey) {
        var lower = String(eventKey).toLowerCase();
        if (lower.indexOf('svs') !== -1) return '#ffe088';
        if (lower.indexOf('gvg') !== -1) return '#a8c7fa';
        if (lower.indexOf('shadowfront') !== -1) return '#d0bcff';
        if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return '#70d7ff';
        if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return '#ffe088';
        if (lower.indexOf('glory') !== -1) return '#6dd58c';
        return '#c4c7c5';
    }

    function renderChartCard(eventKey, ev, idx) {
        var icon = window.GM.getEventIcon(eventKey);
        var accent = eventAccent(eventKey);
        var anyScore = (ev.history || []).some(function (h) { return (h.score || 0) > 0 || (h.guild_avg_score || 0) > 0; });

        // History list: score per session with Guild Average comparison
        var historyHtml = '';
        (ev.history || []).slice(0, 8).forEach(function (h) {
            var label = formatPortalDateDDMMAA(h) || '?';
            var scoreVal = Number(h.score) || 0;
            var avgVal = Number(h.guild_avg_score) || 0;
            var scoreText = anyScore ? (scoreVal > 0 ? window.GM.formatNumber(scoreVal) : '-') : '-';
            var avgText = avgVal > 0 ? window.GM.formatNumber(avgVal) : '-';

            var deltaPill = '';
            if (scoreVal > 0 && avgVal > 0) {
                var diffPct = Math.round(((scoreVal - avgVal) / avgVal) * 1000) / 10;
                if (diffPct >= 0) {
                    deltaPill = '<span class="gm-chip" style="font-size:0.68rem; padding:0.1rem 0.4rem; color:#6dd58c; background:rgba(109,213,140,0.14); border:1px solid rgba(109,213,140,0.25); border-radius:var(--md-sys-shape-corner-full);">+' + diffPct + '% vs Avg</span>';
                } else {
                    deltaPill = '<span class="gm-chip" style="font-size:0.68rem; padding:0.1rem 0.4rem; color:#ffe088; background:rgba(255,224,136,0.14); border:1px solid rgba(255,224,136,0.25); border-radius:var(--md-sys-shape-corner-full);">' + diffPct + '% vs Avg</span>';
                }
            }

            historyHtml +=
                '<div class="portal-chart-row">' +
                    '<span class="portal-chart-row-label">' + esc(label) + '</span>' +
                    '<div style="display:flex; align-items:center; gap:0.65rem;">' +
                        '<span class="portal-chart-row-score" style="color:#6dd58c; font-weight:800;" title="Your Score">' + esc(scoreText) + '</span>' +
                        '<span style="color:#ffe088; font-size:0.75rem; font-weight:700; opacity:0.95;" title="Guild Average">Avg ' + esc(avgText) + '</span>' +
                        deltaPill +
                    '</div>' +
                '</div>';
        });

        return '<div class="portal-chart-card">' +
                    '<div class="portal-chart-accent" style="background:' + accent + ';"></div>' +
                    '<div class="portal-chart-head">' +
                        '<div class="portal-chart-title"><i class="ph ' + icon + '" style="color:' + accent + ';"></i> ' + esc(eventKey) + '</div>' +
                        '<div class="portal-chart-legend">' +
                            '<span style="display:inline-flex; align-items:center; gap:0.4rem; color:#6dd58c; font-weight:700;"><span style="width:12px; height:3px; background:#6dd58c; border-radius:2px; display:inline-block;"></span> You</span>' +
                            '<span style="display:inline-flex; align-items:center; gap:0.4rem; color:#ffe088; font-weight:700;"><span style="width:14px; height:0; border-top:2.5px dashed #ffe088; display:inline-block;"></span> Guild Avg (dashed)</span>' +
                        '</div>' +
                    '</div>' +
                    '<canvas class="portal-chart-canvas" data-chart-key="' + esc(eventKey) + '" data-chart-idx="' + idx + '" width="1200" height="200"></canvas>' +
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
                ? '<span class="portal-badge" style="background:rgba(109,213,140,0.18); color:#6dd58c; border-color:rgba(109,213,140,0.4);">P</span>'
                : (h.excused ? '<span class="portal-badge" style="background:rgba(255,224,136,0.15); color:#ffe088; border-color:rgba(255,224,136,0.4);">E</span>'
                   : '<span class="portal-badge" style="background:rgba(248,113,113,0.15); color:#f87171; border-color:rgba(248,113,113,0.4);">A</span>');
        });

        return '<div class="portal-participation-tile">' +
                    '<div class="portal-chart-accent" style="background:' + accent + ';"></div>' +
                    '<div class="portal-participation-body">' +
                        '<div class="portal-participation-title"><i class="ph ' + icon + '" style="color:' + accent + ';"></i> ' + esc(eventKey) + '</div>' +
                        '<div class="portal-participation-rate">' + esc(ev.rate) + '%</div>' +
                        '<div class="portal-participation-sub">' + esc(attended) + '/' + esc(ev.count) + ' attended</div>' +
                        '<div class="portal-participation-badges">' + recentBadges + '</div>' +
                    '</div>' +
                '</div>';
    }

    // ─── Native canvas line chart: dual-series (player score + guild average) ─
    function drawChart(eventKey, ev, idx) {
        var canvas = document.querySelector('.portal-chart-canvas[data-chart-idx="' + idx + '"]');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Chronological order (oldest first) for the curve.
        var list = (ev.history || []).slice(0, 30).slice().reverse();
        
        if (list.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = '500 13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No data available', w / 2, h / 2);
            return;
        }

        var padL = 40, padR = 40, padT = 32, padB = 36;
        var chartW = w - padL - padR;
        var chartH = h - padT - padB;
        var baseY = padT + chartH;

        var points = list.map(function (h, i) {
            return {
                x: i,
                score: Number(h.score) || 0,
                avg: Number(h.guild_avg_score) || 0,
                label: formatPortalDateDDMMAA(h)
            };
        });

        var maxVal = 1;
        points.forEach(function (p) {
            if (p.score > maxVal) maxVal = p.score;
            if (p.avg > maxVal) maxVal = p.avg;
        });
        maxVal = Math.round(maxVal * 1.25);

        // Subtle horizontal guide lines (No raw text on Y-axis as requested)
        for (var g = 1; g <= 3; g++) {
            var gy = padT + chartH - (chartH * g / 4);
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(padL, gy + 0.5);
            ctx.lineTo(w - padR, gy + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Baseline
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, baseY + 0.5);
        ctx.lineTo(w - padR, baseY + 0.5);
        ctx.stroke();

        var scoredPoints = points.filter(function (p) { return p.score > 0; });
        var avgPoints = points.filter(function (p) { return p.avg > 0; });

        if (scoredPoints.length === 0 && avgPoints.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = '700 13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No scores recorded in this period', w / 2, padT + chartH / 2 - 6);
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '11px Inter, sans-serif';
            ctx.fillText('Scores will appear once submitted and validated', w / 2, padT + chartH / 2 + 14);

            list.forEach(function (h, i) {
                var x = padL + (chartW * i / Math.max(1, list.length - 1));
                var label = formatPortalDateDDMMAA(h);
                ctx.fillStyle = 'rgba(255,255,255,0.65)';
                ctx.font = '11px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(label, x, baseY + 20);
            });
            return;
        }

        var xFor = function (i) { return padL + (chartW * i / Math.max(1, list.length - 1)); };
        var yFor = function (val) { return baseY - (chartH * (val / maxVal)); };

        // 1. Draw GUILD AVERAGE Line (Dashed Amber #ffe088 / #fbbf24 in the graph, NOT on axis)
        if (avgPoints.length > 0) {
            ctx.save();
            ctx.setLineDash([8, 6]);
            ctx.strokeStyle = '#ffe088';
            ctx.lineWidth = 2.2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';

            ctx.beginPath();
            avgPoints.forEach(function (p, i) {
                var x = xFor(p.x), y = yFor(p.avg);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
            ctx.restore();

            // Guild Avg subtle markers & end badge
            avgPoints.forEach(function (p, idx) {
                var x = xFor(p.x), y = yFor(p.avg);
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#1e1f20';
                ctx.fill();
                ctx.strokeStyle = '#ffe088';
                ctx.lineWidth = 1.5;
                ctx.stroke();

                // Draw floating chip badge at the latest point or center
                if (idx === avgPoints.length - 1 || avgPoints.length === 1) {
                    var badgeText = 'Avg ' + window.GM.formatPower(p.avg);
                    ctx.font = '700 10px Inter, sans-serif';
                    var textWidth = ctx.measureText(badgeText).width;
                    var badgeW = textWidth + 14;
                    var badgeH = 18;
                    var badgeX = Math.min(w - padR - badgeW, x - badgeW / 2);
                    var badgeY = y - 22;
                    if (badgeY < padT) badgeY = y + 8;

                    ctx.fillStyle = '#2c2514';
                    ctx.strokeStyle = 'rgba(255, 224, 136, 0.4)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 9);
                    ctx.fill();
                    ctx.stroke();

                    ctx.fillStyle = '#ffe088';
                    ctx.textAlign = 'center';
                    ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 12.5);
                }
            });
        }

        // 2. Draw PLAYER SCORE Curve (Solid Glowing Emerald #6dd58c with Area Fill)
        if (scoredPoints.length > 0) {
            var grad = ctx.createLinearGradient(0, padT, 0, baseY);
            grad.addColorStop(0, 'rgba(109,213,140,0.24)');
            grad.addColorStop(1, 'rgba(109,213,140,0.01)');

            ctx.beginPath();
            scoredPoints.forEach(function (p, i) {
                var x = xFor(p.x), y = yFor(p.score);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            if (scoredPoints.length > 1) {
                ctx.lineTo(xFor(scoredPoints[scoredPoints.length - 1].x), baseY);
                ctx.lineTo(xFor(scoredPoints[0].x), baseY);
                ctx.closePath();
                ctx.fillStyle = grad;
                ctx.fill();
            }

            ctx.beginPath();
            scoredPoints.forEach(function (p, i) {
                var x = xFor(p.x), y = yFor(p.score);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.strokeStyle = '#6dd58c';
            ctx.lineWidth = 3.0;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();

            // Glowing score nodes with clean compact power labels (e.g. 33.4M, 71.1M)
            scoredPoints.forEach(function (p) {
                var x = xFor(p.x), y = yFor(p.score);
                
                // Outer ring
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(109,213,140,0.35)';
                ctx.fill();

                // Inner core
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#6dd58c';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.8;
                ctx.stroke();

                // Formatted score text (compact) above point
                var scoreFormatted = window.GM.formatPower(p.score);
                ctx.font = '800 11px Inter, sans-serif';
                var sWidth = ctx.measureText(scoreFormatted).width;
                var sPillW = sWidth + 10;
                var sPillH = 17;
                var sPillX = x - sPillW / 2;
                var sPillY = y - 22;
                if (sPillY < padT) sPillY = y + 8;

                ctx.fillStyle = 'rgba(17, 17, 20, 0.85)';
                ctx.strokeStyle = 'rgba(109, 213, 140, 0.4)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.roundRect(sPillX, sPillY, sPillW, sPillH, 4);
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = '#e3e3e3';
                ctx.textAlign = 'center';
                ctx.fillText(scoreFormatted, x, sPillY + 12);
            });
        }

        // Date labels below the axis (JJ/MM/AA format)
        list.forEach(function (h, i) {
            var x = xFor(i);
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.font = '600 11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(formatPortalDateDDMMAA(h), x, baseY + 20);
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
                    '<p class="gm-page-subtitle">Manage your power, military metrics, glory, timezone and guild transfer requests</p>' +
                '</div>' +
            '</header>' +
            '<div class="portal-settings-grid">' +

                '<div class="portal-card" style="grid-column: 1 / -1;">' +
                    '<div class="portal-card-title" style="display:flex; justify-content:space-between; align-items:center;">' +
                        '<span><i class="ph ph-shield-chevron"></i> My Military Force Metrics</span>' +
                        '<button class="gm-help-btn" data-help-id="help-portal-power" aria-label="Help: My Military Metrics"><i class="ph ph-info"></i></button>' +
                    '</div>' +
                    '<div class="portal-settings-sub" style="font-size:0.85rem; color:var(--text-muted); margin-bottom:1rem;">' +
                        'Keep your combat metrics up to date to help your officers build optimal squads for SvS, GvG, and Shadowfront.' +
                    '</div>' +
                    '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.85rem; margin-bottom: 1rem;">' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-power" style="font-size:0.8rem; font-weight:600; color:var(--fg); margin-bottom:0.25rem; display:block;">Overall Total Power</label>' +
                            '<input type="text" id="portal-user-power" class="gm-input" placeholder="e.g. 100000000" value="' + esc(portalState.player.overall_power || '') + '">' +
                        '</div>' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-fleet" style="font-size:0.8rem; font-weight:600; color:#60a5fa; margin-bottom:0.25rem; display:block;">⚔️ Fleet Rating (March 1)</label>' +
                            '<input type="text" id="portal-user-fleet" class="gm-input" placeholder="e.g. 2000000" value="' + esc(portalState.player.fleet_rating || '') + '">' +
                        '</div>' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-tech" style="font-size:0.8rem; font-weight:600; color:#a78bfa; margin-bottom:0.25rem; display:block;">🔬 Technology Power</label>' +
                            '<input type="text" id="portal-user-tech" class="gm-input" placeholder="e.g. 15000000" value="' + esc(portalState.player.tech_power || '') + '">' +
                        '</div>' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-flagship" style="font-size:0.8rem; font-weight:600; color:#fbbf24; margin-bottom:0.25rem; display:block;">🚀 Flagship Power</label>' +
                            '<input type="text" id="portal-user-flagship" class="gm-input" placeholder="e.g. 10000000" value="' + esc(portalState.player.flagship_power || '') + '">' +
                        '</div>' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-champion" style="font-size:0.8rem; font-weight:600; color:#f472b6; margin-bottom:0.25rem; display:block;">👑 Champions Total Power</label>' +
                            '<input type="text" id="portal-user-champion" class="gm-input" placeholder="e.g. 30000000" value="' + esc(portalState.player.champion_power || '') + '">' +
                        '</div>' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-crew" style="font-size:0.8rem; font-weight:600; color:#38bdf8; margin-bottom:0.25rem; display:block;">👥 Crew Total Power</label>' +
                            '<input type="text" id="portal-user-crew" class="gm-input" placeholder="e.g. 5000000" value="' + esc(portalState.player.crew_power || '') + '">' +
                        '</div>' +
                        '<div class="portal-field">' +
                            '<label for="portal-user-glory" style="font-size:0.8rem; font-weight:600; color:#34d399; margin-bottom:0.25rem; display:block;">🏆 Glory Score</label>' +
                            '<input type="text" id="portal-user-glory" class="gm-input" placeholder="e.g. 50000000" value="' + esc(portalState.player.glory_score || portalState.player.glory || '') + '">' +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">' +
                        '<div id="portal-metrics-summary" style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">' +
                            '<span class="gm-chip" id="portal-density-chip" style="color:#818cf8; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.3); font-size:0.75rem;"><i class="ph ph-shield-check"></i> Density: ' + (window.GM.calculateCombatDensity ? window.GM.calculateCombatDensity(portalState.player) : 0) + '%</span>' +
                            '<span class="gm-chip" id="portal-combativity-chip" style="color:#34d399; background:rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.3); font-size:0.75rem;"><i class="ph ph-crosshair"></i> Combativity: ' + (window.GM.calculateCombativity ? window.GM.calculateCombativity(portalState.player) : 0) + 'x</span>' +
                        '</div>' +
                        '<button type="button" id="portal-update-metrics-btn" class="gm-btn gm-btn-primary"><i class="ph ph-floppy-disk"></i><span>Save Military Metrics</span></button>' +
                    '</div>' +
                    '<div class="portal-msg" id="portal-metrics-msg"></div>' +
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

        // Military Metrics inputs auto-formatter
        var powerInput    = document.getElementById('portal-user-power');
        var fleetInput    = document.getElementById('portal-user-fleet');
        var techInput     = document.getElementById('portal-user-tech');
        var flagshipInput = document.getElementById('portal-user-flagship');
        var champInput    = document.getElementById('portal-user-champion');
        var crewInput     = document.getElementById('portal-user-crew');
        var gloryInput    = document.getElementById('portal-user-glory');
        var metricsBtn    = document.getElementById('portal-update-metrics-btn');
        var metricsMsg    = document.getElementById('portal-metrics-msg');

        [powerInput, fleetInput, techInput, flagshipInput, champInput, crewInput, gloryInput].forEach(function (inp) {
            if (inp) {
                window.GM.attachNumberFormatter(inp);
                inp.addEventListener('input', function () {
                    var curObj = {
                        overall_power: parseInt(String(powerInput.value).replace(/[^0-9]/g, ''), 10) || 0,
                        fleet_rating:   parseInt(String(fleetInput.value).replace(/[^0-9]/g, ''), 10) || 0,
                        tech_power:     parseInt(String(techInput.value).replace(/[^0-9]/g, ''), 10) || 0,
                        flagship_power: parseInt(String(flagshipInput.value).replace(/[^0-9]/g, ''), 10) || 0,
                        champion_power: parseInt(String(champInput.value).replace(/[^0-9]/g, ''), 10) || 0,
                        crew_power:     parseInt(String(crewInput.value).replace(/[^0-9]/g, ''), 10) || 0,
                        glory_score:    parseInt(String(gloryInput.value).replace(/[^0-9]/g, ''), 10) || 0
                    };
                    var d = window.GM.calculateCombatDensity ? window.GM.calculateCombatDensity(curObj) : 0;
                    var c = window.GM.calculateCombativity ? window.GM.calculateCombativity(curObj) : 0;
                    var dChip = document.getElementById('portal-density-chip');
                    var cChip = document.getElementById('portal-combativity-chip');
                    if (dChip) dChip.innerHTML = '<i class="ph ph-shield-check"></i> Density: ' + d + '%';
                    if (cChip) cChip.innerHTML = '<i class="ph ph-crosshair"></i> Combativity: ' + c + 'x';
                });
            }
        });

        if (metricsBtn) metricsBtn.addEventListener('click', async function () {
            var totalVal    = powerInput    ? parseInt(String(powerInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;
            var fleetVal    = fleetInput    ? parseInt(String(fleetInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;
            var techVal     = techInput     ? parseInt(String(techInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;
            var flagshipVal = flagshipInput ? parseInt(String(flagshipInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;
            var champVal    = champInput    ? parseInt(String(champInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;
            var crewVal     = crewInput     ? parseInt(String(crewInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;
            var gloryVal    = gloryInput    ? parseInt(String(gloryInput.value).replace(/[^0-9]/g, ''), 10) || 0 : 0;

            if (totalVal < 0) {
                window.GM.showToast('Please enter a valid power number.', 'error');
                return;
            }

            metricsBtn.disabled = true;
            var span = metricsBtn.querySelector('span');
            var origText = span ? span.textContent : '';
            if (span) span.textContent = 'Saving...';

            try {
                var res = await invoke('update-metrics', {
                    total_power: totalVal,
                    fleet_rating: fleetVal,
                    tech_power: techVal,
                    flagship_power: flagshipVal,
                    champion_power: champVal,
                    crew_power: crewVal,
                    glory_score: gloryVal
                });

                if (!res.ok) throw new Error(res.error || 'update_failed');

                portalState.player.overall_power  = totalVal;
                portalState.player.fleet_rating   = fleetVal;
                portalState.player.tech_power     = techVal;
                portalState.player.flagship_power = flagshipVal;
                portalState.player.champion_power = champVal;
                portalState.player.crew_power     = crewVal;
                portalState.player.glory_score    = gloryVal;
                portalState.player.glory          = gloryVal;

                var headerPower = document.querySelector('.portal-header-power-value');
                if (headerPower) headerPower.textContent = window.GM.formatPower(totalVal);

                if (metricsMsg) {
                    metricsMsg.textContent = 'Military force metrics saved successfully!';
                    metricsMsg.style.color = 'var(--success)';
                    metricsMsg.style.display = 'block';
                }
                window.GM.showToast('Your military force metrics have been updated!', 'success');
            } catch (err) {
                if (metricsMsg) {
                    metricsMsg.textContent = 'Failed to save: ' + err.message;
                    metricsMsg.style.color = 'var(--danger)';
                    metricsMsg.style.display = 'block';
                }
                window.GM.showToast('Failed to update metrics: ' + err.message, 'error');
            } finally {
                metricsBtn.disabled = false;
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
