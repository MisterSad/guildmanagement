/**
 * stats.js — Classements et profils :
 *   • Global (semaine)        — note /20, comme avant
 *   • SvS                     — classement par score SvS de la semaine
 *   • GvG                     — classement par score GvG de la semaine
 *   • Prince Rewards (2 sem.) — note /20 cumulée sur les 2 dernières semaines
 *
 * Formule /20 :  participation (16 pts) + glory normalisée (4 pts)
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

    // ── State ──────────────────────────────────────────────────────────────────
    var currentWeek     = window.RAD ? window.RAD.getWeekStart() : '';
    var allWeeks        = [];
    var leaderboardData = [];
    var currentMode     = 'global'; // 'global' | 'SvS' | 'GvG' | 'prince'

    // ── Public API ──────────────────────────────────────────────────────────────
    window.RAD_STATS = { load: loadStats };

    // ── Entry point ─────────────────────────────────────────────────────────────
    async function loadStats() {
        if (!db) return;
        await fetchAllWeeks();
        renderControls();
        await refreshData();
    }

    async function refreshData() {
        if (currentMode === 'global') {
            await loadGlobalWeek(currentWeek);
        } else if (currentMode === 'SvS' || currentMode === 'GvG') {
            await loadEventRanking(currentMode, currentWeek);
        } else if (currentMode === 'prince') {
            await loadPrinceRewards();
        }
    }

    // ── Liste des semaines disponibles ───────────────────────────────────────────
    async function fetchAllWeeks() {
        var res = await db.from('event_participants').select('week_start');
        var weeks = [];
        if (res.data) weeks = Array.from(new Set(res.data.map(function (r) { return r.week_start; })));
        weeks.sort(function (a, b) { return b.localeCompare(a); });
        if (weeks.indexOf(currentWeek) === -1) weeks.unshift(currentWeek);
        allWeeks = weeks;
    }

    // ── Global week : /20 calculé en agrégeant toutes les sessions ─────────────
    async function loadGlobalWeek(week) {
        var [membersRes, partsRes] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*').eq('week_start', week)
        ]);

        var members      = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var participants = partsRes.data || [];
        if (members.length === 0) { renderEmpty(); return; }

        var scores = computeWeeklyScores(members, participants);
        scores.forEach(function (s) { s.week_start = week; });
        leaderboardData = scores;
        renderLeaderboard({ mode: 'global' });
    }

    // ── SvS / GvG : classement par score de la semaine (toutes sessions cumulées)
    async function loadEventRanking(eventName, week) {
        var res = await db.from('event_participants')
            .select('pseudo, score, participated')
            .eq('event_name', eventName)
            .eq('week_start', week);

        var agg = {};
        (res.data || []).forEach(function (r) {
            if (!agg[r.pseudo]) agg[r.pseudo] = { pseudo: r.pseudo, score: 0, participated: 0 };
            agg[r.pseudo].score        += (r.score        || 0);
            agg[r.pseudo].participated += (r.participated || 0);
        });

        leaderboardData = Object.values(agg)
            .filter(function (r) { return r.score > 0 || r.participated > 0; })
            .map(function (r) {
                return {
                    pseudo: r.pseudo,
                    score_20: r.score,
                    events_done: r.participated,
                    is_event_mode: true
                };
            })
            .sort(function (a, b) {
                if (b.score_20 !== a.score_20) return b.score_20 - a.score_20;
                return a.pseudo.localeCompare(b.pseudo);
            });

        renderLeaderboard({ mode: 'event' });
    }

    // ── Prince Rewards : /20 sur les 2 dernières semaines ───────────────────────
    async function loadPrinceRewards() {
        var w1 = currentWeek;
        var w0 = window.RAD.getPrevWeekStart(w1);

        var [membersRes, partsRes] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*').in('week_start', [w0, w1])
        ]);
        var members = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var participants = partsRes.data || [];
        if (members.length === 0) { renderEmpty(); return; }

        var scores = computeWeeklyScores(members, participants);
        scores.forEach(function (s) { s.week_range = w0 + ' → ' + w1; });
        leaderboardData = scores;
        renderLeaderboard({ mode: 'prince', range: { from: w0, to: w1 } });
    }

    // ── Calcul commun /20 ───────────────────────────────────────────────────────
    function computeWeeklyScores(members, participants) {
        // Glory rows séparés
        var gloryRows = participants.filter(function (p) { return p.event_name === 'Glory'; });
        var nonGlory  = participants.filter(function (p) { return p.event_name !== 'Glory'; });

        // Distinct event names (hors Glory) → events_total
        var nonGloryEvents = Array.from(new Set(nonGlory.map(function (p) { return p.event_name; })));
        var eventsTotal = nonGloryEvents.length;

        // Glory max sur la période
        var maxGlory = gloryRows.reduce(function (mx, r) { return Math.max(mx, r.score || 0); }, 0);

        return members.map(function (pseudo) {
            // Pour chaque event_name distinct, compter le total de participations
            var memberParts = nonGlory.filter(function (p) { return p.pseudo === pseudo; });
            var doneByEvent = {};
            memberParts.forEach(function (p) {
                doneByEvent[p.event_name] = (doneByEvent[p.event_name] || 0) + (p.participated || 0);
            });
            var eventsDone = Object.values(doneByEvent).filter(function (v) { return v > 0; }).length;
            var participationScore = eventsTotal > 0 ? (eventsDone / eventsTotal) * 16 : 0;

            // Glory : somme sur la période
            var gloryScore = gloryRows
                .filter(function (r) { return r.pseudo === pseudo; })
                .reduce(function (s, r) { return s + (r.score || 0); }, 0);
            var gloryNorm  = maxGlory > 0 ? (gloryScore / maxGlory) * 4 : 0;

            var total = Math.round((participationScore + gloryNorm) * 10) / 10;
            return {
                pseudo: pseudo,
                score_20: total,
                events_done: eventsDone,
                events_total: eventsTotal,
                glory_score: gloryScore
            };
        }).sort(function (a, b) {
            if (b.score_20 !== a.score_20) return b.score_20 - a.score_20;
            return a.pseudo.localeCompare(b.pseudo);
        });
    }

    // ── Render contrôles : sélecteur de semaine + onglets de mode ──────────────
    function renderControls() {
        document.querySelectorAll('.stats-controls').forEach(function (el) {
            var optHtml = allWeeks.map(function (w) {
                return '<option value="' + w + '"' + (w === currentWeek ? ' selected' : '') + '>' + window.RAD.formatWeek(w) + '</option>';
            }).join('');

            var modes = [
                { key: 'global', label: t('stats_tab_global'),  icon: 'ph-globe' },
                { key: 'SvS',    label: t('stats_tab_svs'),     icon: 'ph-sword' },
                { key: 'GvG',    label: t('stats_tab_gvg'),     icon: 'ph-flag-banner' },
                { key: 'prince', label: t('stats_tab_prince'),  icon: 'ph-crown' }
            ];

            var tabsHtml = '<div class="stats-mode-tabs">' +
                modes.map(function (m) {
                    return '<button class="stats-mode-tab' + (currentMode === m.key ? ' active' : '') + '" data-mode="' + m.key + '">' +
                        '<i class="ph ' + m.icon + '"></i> ' + m.label + '</button>';
                }).join('') +
            '</div>';

            el.innerHTML =
                '<div class="stats-controls-inner">' +
                    '<div class="stats-left-controls">' +
                        '<select class="week-select">' + optHtml + '</select>' +
                    '</div>' +
                '</div>' +
                tabsHtml;

            el.querySelector('.week-select').addEventListener('change', function () {
                currentWeek = this.value;
                refreshData();
            });

            el.querySelectorAll('.stats-mode-tab').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    currentMode = btn.getAttribute('data-mode');
                    renderControls();
                    refreshData();
                });
            });
        });
    }

    // ── Render leaderboard ──────────────────────────────────────────────────────
    function renderLeaderboard(opts) {
        var mode = opts && opts.mode;
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (container) {
            if (!leaderboardData.length) {
                container.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-chart-bar"></i><p>' + t('stats_no_data') + '</p></div>';
                return;
            }

            var isEvent = mode === 'event';

            var bannerHtml = '';
            if (mode === 'prince' && opts.range) {
                bannerHtml =
                    '<div class="stats-prince-banner">' +
                        '<i class="ph-fill ph-crown"></i> ' +
                        '<span>' + t('stats_prince_banner') + ' : ' +
                            window.RAD.formatWeek(opts.range.from) + ' → ' + window.RAD.formatWeek(opts.range.to) +
                        '</span>' +
                    '</div>';
            }

            // Podium
            var top = leaderboardData.slice(0, Math.min(3, leaderboardData.length));
            var podOrder = top.length >= 3 ? [top[1], top[0], top[2]]
                         : top.length === 2 ? [top[1], top[0]]
                         : [top[0]];
            var medals = { 0: '🥇', 1: '🥈', 2: '🥉' };
            var heights = { 0: 90, 1: 120, 2: 70 };

            var podHtml = '<div class="stats-podium">';
            podOrder.forEach(function (m, i) {
                var orig = leaderboardData.indexOf(m);
                var scoreDisplay = isEvent ? m.score_20 : parseFloat(m.score_20).toFixed(1) + '/20';
                podHtml +=
                    '<div class="podium-slot rank-' + (orig + 1) + '" data-pseudo="' + esc(m.pseudo) + '">' +
                        '<div class="podium-medal">' + (medals[orig] || '') + '</div>' +
                        '<div class="podium-name">' + esc(m.pseudo) + '</div>' +
                        '<div class="podium-score-val">' + scoreDisplay + '</div>' +
                        '<div class="podium-bar" style="height:' + heights[i] + 'px">' +
                            '<div class="podium-bar-fill" style="height:' + heights[i] + 'px"></div>' +
                        '</div>' +
                    '</div>';
            });
            podHtml += '</div>';

            // Table
            var tableHtml =
                '<div class="leaderboard-wrap">' +
                '<table class="leaderboard-table"><thead><tr>' +
                    '<th>#</th>' +
                    '<th>' + t('col_member') + '</th>' +
                    '<th class="center">' + (isEvent ? t('col_score') : t('stats_score')) + '</th>' +
                    (!isEvent ? '<th class="center">' + t('stats_events') + '</th>' : '') +
                    (!isEvent ? '<th class="center">Glory</th>' : '') +
                    '<th class="center">' + t('stats_profile') + '</th>' +
                '</tr></thead><tbody>';

            leaderboardData.forEach(function (m, i) {
                var rank = i + 1;
                var badge = rank <= 3 ? medals[i] : '#' + rank;
                var s = parseFloat(m.score_20);
                var cls = isEvent ? 'score-event' : (s >= 16 ? 'score-high' : s >= 10 ? 'score-mid' : 'score-low');
                var scoreDisplay = isEvent ? m.score_20 : s.toFixed(1) + '/20';

                tableHtml +=
                    '<tr class="lb-row">' +
                        '<td class="rank-cell">' + badge + '</td>' +
                        '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + esc(m.pseudo) + '</td>' +
                        '<td class="center"><span class="score-badge ' + cls + '">' + scoreDisplay + '</span></td>' +
                        (!isEvent ? '<td class="center">' + m.events_done + '/' + m.events_total + '</td>' : '') +
                        (!isEvent ? '<td class="center">' + (m.glory_score || 0) + '</td>' : '') +
                        '<td class="center">' +
                            '<button class="profile-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('stats_see_profile') + '">' +
                                '<i class="ph ph-chart-line-up"></i>' +
                            '</button>' +
                        '</td>' +
                    '</tr>';
            });
            tableHtml += '</tbody></table></div>';

            container.innerHTML = bannerHtml + podHtml + tableHtml;

            container.querySelectorAll('.profile-btn, .podium-slot').forEach(function (btn) {
                btn.addEventListener('click', function () { openProfile(btn.getAttribute('data-pseudo')); });
            });
        });
    }

    function renderEmpty() {
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (el) {
            el.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-chart-bar"></i><p>' + t('stats_no_data') + '</p></div>';
        });
    }

    // ── Profil : historique calculé à la volée par semaine ──────────────────────
    async function openProfile(pseudo) {
        // Récupérer toutes les rows de ce membre
        var [membersRes, partsRes] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*')
        ]);
        var allMembers = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var allParts   = partsRes.data || [];

        var weeks = Array.from(new Set(allParts.map(function (r) { return r.week_start; }))).sort();

        var history = weeks.map(function (w) {
            var weekParts = allParts.filter(function (r) { return r.week_start === w; });
            var scoresOfWeek = computeWeeklyScores(allMembers, weekParts);
            var found = scoresOfWeek.find(function (s) { return s.pseudo === pseudo; });
            return {
                week_start:   w,
                score_20:     found ? found.score_20     : 0,
                events_done:  found ? found.events_done  : 0,
                events_total: found ? found.events_total : 0,
                glory_score:  found ? found.glory_score  : 0
            };
        }).filter(function (r) { return r.events_total > 0 || r.glory_score > 0; });

        renderProfileModal(pseudo, history);
    }

    function renderProfileModal(pseudo, history) {
        var existing = document.getElementById('profile-modal');
        if (existing) existing.remove();

        var avg  = history.length ? (history.reduce(function (s, r) { return s + parseFloat(r.score_20); }, 0) / history.length).toFixed(1) : '—';
        var best = history.length ? Math.max.apply(null, history.map(function (r) { return parseFloat(r.score_20); })).toFixed(1) : '—';
        var trend = history.length >= 2
            ? (parseFloat(history[history.length - 1].score_20) - parseFloat(history[history.length - 2].score_20)).toFixed(1)
            : null;
        var trendHtml = trend !== null
            ? '<span class="stat-chip ' + (parseFloat(trend) >= 0 ? 'success' : 'muted') + '">' +
              (parseFloat(trend) >= 0 ? '↑' : '↓') + ' ' + Math.abs(trend) + '</span>'
            : '';

        var modal = document.createElement('div');
        modal.id = 'profile-modal';
        modal.className = 'confirm-overlay';

        var html =
            '<div class="profile-card glass-card">' +
                '<div class="profile-header">' +
                    '<div class="profile-avatar"><i class="ph-fill ph-user-circle"></i></div>' +
                    '<div class="profile-info">' +
                        '<h2 class="text-gradient">' + esc(pseudo) + '</h2>' +
                        '<div class="profile-meta-row">' +
                            '<span class="stat-chip accent"><i class="ph-fill ph-trophy"></i> Moy. ' + avg + '/20</span>' +
                            '<span class="stat-chip success"><i class="ph-fill ph-star"></i> Best ' + best + '/20</span>' +
                            '<span class="stat-chip"><i class="ph-fill ph-calendar"></i> ' + history.length + ' sem.</span>' +
                            trendHtml +
                        '</div>' +
                    '</div>' +
                    '<button class="icon-btn profile-close" title="Fermer"><i class="ph ph-x"></i></button>' +
                '</div>';

        if (history.length >= 2) {
            html += '<div class="profile-sparkline">' + buildSparkline(
                history.map(function (r) { return parseFloat(r.score_20); }),
                history.map(function (r) { return r.week_start; })
            ) + '</div>';
        }

        html +=
            '<div class="profile-history">' +
            '<table class="leaderboard-table"><thead><tr>' +
                '<th>' + t('stats_week') + '</th>' +
                '<th class="center">' + t('stats_score') + '</th>' +
                '<th class="center">' + t('stats_events') + '</th>' +
                '<th class="center">Glory</th>' +
            '</tr></thead><tbody>';

        history.slice().reverse().forEach(function (row) {
            var s = parseFloat(row.score_20);
            var cls = s >= 16 ? 'score-high' : s >= 10 ? 'score-mid' : 'score-low';
            html +=
                '<tr><td class="week-cell">' + window.RAD.formatWeek(row.week_start) + '</td>' +
                '<td class="center"><span class="score-badge ' + cls + '">' + s.toFixed(1) + '/20</span></td>' +
                '<td class="center">' + row.events_done + '/' + row.events_total + '</td>' +
                '<td class="center">' + (row.glory_score || 0) + '</td></tr>';
        });

        html += '</tbody></table></div></div>';
        modal.innerHTML = html;
        document.body.appendChild(modal);
        requestAnimationFrame(function () { modal.classList.add('visible'); });

        modal.querySelector('.profile-close').addEventListener('click', function () { closeModal(modal); });
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(modal); });
    }

    function closeModal(modal) {
        modal.classList.remove('visible');
        setTimeout(function () { modal.remove(); }, 300);
    }

    // ── SVG Sparkline ────────────────────────────────────────────────────────────
    function buildSparkline(scores, weeks) {
        var W = 500, H = 100, px = 16, py = 12;
        var n = scores.length;
        var pts = scores.map(function (s, i) {
            var x = px + (n === 1 ? (W - px * 2) / 2 : (i / (n - 1)) * (W - px * 2));
            var y = H - py - (s / 20) * (H - py * 2);
            return [x.toFixed(1), y.toFixed(1)];
        });

        var line = pts.map(function (p) { return p.join(','); }).join(' ');
        var area = (px + ',' + (H - py) + ' ') + line + (' ' + (W - px) + ',' + (H - py));
        var dots = pts.map(function (p, i) {
            var cls = i === n - 1 ? 'sp-dot sp-dot-last' : 'sp-dot';
            return '<circle class="' + cls + '" cx="' + p[0] + '" cy="' + p[1] + '" r="4"/>';
        }).join('');

        var yLines = [0, 10, 20].map(function (v) {
            var y = H - py - (v / 20) * (H - py * 2);
            return '<line x1="' + px + '" x2="' + (W - px) + '" y1="' + y + '" y2="' + y + '" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4"/>' +
                   '<text x="' + (px - 4) + '" y="' + (y + 4) + '" text-anchor="end" font-size="9" fill="#64748b">' + v + '</text>';
        }).join('');

        var step = Math.max(1, Math.floor(n / 6));
        var xLabels = pts.filter(function (_, i) { return i % step === 0 || i === n - 1; }).map(function (p, idx) {
            var wi = idx * step;
            if (wi >= n) wi = n - 1;
            var d = new Date(weeks[wi] + 'T12:00:00');
            var label = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            return '<text x="' + p[0] + '" y="' + (H + 2) + '" text-anchor="middle" font-size="9" fill="#64748b">' + label + '</text>';
        }).join('');

        return '<svg viewBox="0 0 ' + W + ' ' + (H + 12) + '" class="sparkline-svg" preserveAspectRatio="none">' +
            '<defs><linearGradient id="sg1" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#6366f1" stop-opacity="0.35"/>' +
                '<stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            yLines +
            '<polygon points="' + area + '" fill="url(#sg1)"/>' +
            '<polyline points="' + line + '" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            dots + xLabels +
        '</svg>';
    }

})();
