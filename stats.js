/**
 * stats.js — Classements pondérés.
 *
 * Algorithme (par joueur p sur une période) :
 *   S_e(p)   = C_e × (α × participé + β × score_tracké × score(p) / max_guilde(score))
 *   S_total  = Σ S_e
 *   B_glory  = (Δgloire(p) / max Δgloire) × Bg          si Δ > 0
 *   B_conso  = Bc                                       si attendance ≥ θ
 *   Score    = S_total + B_glory + B_conso
 *
 * Coefficients : SvS=GvG=5, Shadowfront=3, DTR=2, ArmsRace=1
 * α = 6 (participation), β = 4 (performance), Bg = 20, Bc = 15, θ = 80%
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };
    var fmt = window.RAD ? window.RAD.formatNumber : function (n) { return String(n); };

    // ── Configuration formule ───────────────────────────────────────────────────
    var EVENT_GROUPS = {
        'SvS':         { coeff: 5, hasScore: true,  dbNames: ['SvS'] },
        'GvG':         { coeff: 5, hasScore: true,  dbNames: ['GvG'] },
        'Shadowfront': { coeff: 3, hasScore: false, dbNames: ['Shadowfront'] },
        'DTR':         { coeff: 2, hasScore: false, dbNames: ['Defend Trade Route'] },
        'Arms Race':   { coeff: 1, hasScore: false, dbNames: ['ARMS RACE STAGE A', 'ARMS RACE STAGE B'] }
    };

    var W = {
        participation: 6,
        performance:   4,
        gloryMax:      20,
        consistency:   15,
        threshold:     0.80
    };

    function maxEventScore(group) {
        return group.coeff * (W.participation + (group.hasScore ? W.performance : 0));
    }

    // ── State ──────────────────────────────────────────────────────────────────
    var currentWeek     = window.RAD ? window.RAD.getWeekStart() : '';
    var allWeeks        = [];
    var leaderboardData = [];
    var lastMaxPossible = 0;
    var currentMode     = 'global'; // 'global' | 'SvS' | 'GvG' | 'prince'

    // ── Public API ──────────────────────────────────────────────────────────────
    window.RAD_STATS = { load: loadStats };

    async function loadStats() {
        if (!db) return;
        await fetchAllWeeks();
        renderControls();
        await refreshData();
    }

    async function refreshData() {
        if (currentMode === 'global') {
            await loadGlobalPeriod([currentWeek]);
        } else if (currentMode === 'SvS' || currentMode === 'GvG') {
            await loadEventRanking(currentMode, currentWeek);
        } else if (currentMode === 'prince') {
            var w0 = window.RAD.getPrevWeekStart(currentWeek);
            await loadGlobalPeriod([w0, currentWeek], { princeBanner: true, range: { from: w0, to: currentWeek } });
        }
    }

    // ── Fetch des semaines disponibles ──────────────────────────────────────────
    // RPC car SELECT direct est plafonné à 1 000 lignes côté PostgREST : avec
    // plusieurs centaines de participants × semaines, certaines semaines
    // disparaissaient du sélecteur.
    async function fetchAllWeeks() {
        var res = await db.rpc('list_event_weeks');
        var weeks = (res.data || []).map(function (r) { return r.week_start; });
        weeks.sort(function (a, b) { return b.localeCompare(a); });
        if (weeks.indexOf(currentWeek) === -1) weeks.unshift(currentWeek);
        allWeeks = weeks;
    }

    // ── Mode Global / Prince : application de la formule pondérée ──────────────
    async function loadGlobalPeriod(weeks, opts) {
        opts = opts || {};
        // Pour la Δgloire on a besoin de la semaine précédant la première du période
        var refPrev = window.RAD.getPrevWeekStart(weeks[0]);
        var glorySpan = [refPrev].concat(weeks);

        var [membersRes, partsRes, gloryRes] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*').in('week_start', weeks).neq('event_name', 'Glory').limit(100000),
            db.from('event_participants').select('pseudo, score, week_start').eq('event_name', 'Glory').in('week_start', glorySpan).limit(100000)
        ]);

        var members      = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var participants = partsRes.data || [];
        var gloryByWeek  = buildGloryByWeek(gloryRes.data || [], glorySpan);

        if (members.length === 0) { renderEmpty(); return; }

        var result = computeScores(members, participants, gloryByWeek, weeks);
        leaderboardData = result.scores;
        lastMaxPossible = result.maxPossible;
        renderLeaderboard({
            mode:         opts.princeBanner ? 'prince' : 'global',
            range:        opts.range,
            maxPossible:  result.maxPossible,
            ranEvents:    result.ranEvents
        });
    }

    // ── Mode SvS / GvG : classement brut par score d'événement ─────────────────
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
                    pseudo:        r.pseudo,
                    score:         r.score,
                    events_done:   r.participated,
                    is_event_mode: true
                };
            })
            .sort(function (a, b) {
                if (b.score !== a.score) return b.score - a.score;
                return a.pseudo.localeCompare(b.pseudo);
            });

        lastMaxPossible = leaderboardData.length ? leaderboardData[0].score : 0;
        renderLeaderboard({ mode: 'event', maxPossible: lastMaxPossible });
    }

    // ── Construction de la map gloire par semaine ──────────────────────────────
    function buildGloryByWeek(rows, weeks) {
        var byWeek = {};
        weeks.forEach(function (w) { byWeek[w] = {}; });
        rows.forEach(function (r) {
            if (!byWeek[r.week_start]) byWeek[r.week_start] = {};
            byWeek[r.week_start][r.pseudo] = r.score || 0;
        });
        return byWeek;
    }

    // ── Calcul du score selon la nouvelle formule ──────────────────────────────
    function computeScores(members, participants, gloryByWeek, periodWeeks) {
        // 1. Identifier les événements qui ont tourné dans la période
        var ranEvents = {};
        Object.keys(EVENT_GROUPS).forEach(function (name) {
            var group = EVENT_GROUPS[name];
            var hasRows = participants.some(function (p) {
                return group.dbNames.indexOf(p.event_name) !== -1;
            });
            if (hasRows) ranEvents[name] = group;
        });
        var eventsTotal = Object.keys(ranEvents).length;

        // 2. Pour chaque événement avec score, calculer le max guilde (somme des sessions)
        var maxScorePerEvent = {};
        Object.keys(ranEvents).forEach(function (name) {
            var group = ranEvents[name];
            if (!group.hasScore) { maxScorePerEvent[name] = 0; return; }
            var perPlayer = {};
            participants.forEach(function (p) {
                if (group.dbNames.indexOf(p.event_name) === -1) return;
                perPlayer[p.pseudo] = (perPlayer[p.pseudo] || 0) + (p.score || 0);
            });
            var values = Object.values(perPlayer);
            maxScorePerEvent[name] = values.length ? Math.max.apply(null, values) : 0;
        });

        // 3. Δgloire par joueur (somme des deltas positifs sur la période)
        var weekStarts = Object.keys(gloryByWeek).sort();
        var deltaByPseudo = {};
        members.forEach(function (pseudo) {
            var totalDelta = 0;
            for (var i = 1; i < weekStarts.length; i++) {
                var curr = gloryByWeek[weekStarts[i]][pseudo] || 0;
                var prev = gloryByWeek[weekStarts[i - 1]][pseudo] || 0;
                var d = curr - prev;
                if (d > 0) totalDelta += d;
            }
            deltaByPseudo[pseudo] = totalDelta;
        });
        var maxDelta = Math.max.apply(null, Object.values(deltaByPseudo).concat([0]));

        // 4. Score par joueur (avec décomposition pour transparence)
        var scores = members.map(function (pseudo) {
            var eventsScore = 0;
            var eventsAttended = 0;
            var perEvent = {};

            Object.keys(ranEvents).forEach(function (name) {
                var group = ranEvents[name];
                var rows = participants.filter(function (p) {
                    return p.pseudo === pseudo && group.dbNames.indexOf(p.event_name) !== -1;
                });
                var participated = rows.some(function (r) { return r.participated > 0; });
                var totalScore = rows.reduce(function (s, r) { return s + (r.score || 0); }, 0);

                var base = participated ? W.participation * group.coeff : 0;
                var perf = 0;
                if (participated && group.hasScore && maxScorePerEvent[name] > 0) {
                    perf = W.performance * group.coeff * (totalScore / maxScorePerEvent[name]);
                }
                var eventScore = base + perf;
                eventsScore += eventScore;
                if (participated) eventsAttended++;

                perEvent[name] = {
                    coeff:        group.coeff,
                    participated: participated,
                    score:        totalScore,
                    base:         round1(base),
                    perf:         round1(perf),
                    total:        round1(eventScore),
                    max:          maxEventScore(group)
                };
            });

            var attendanceRate = eventsTotal > 0 ? eventsAttended / eventsTotal : 0;
            var consistencyBonus = attendanceRate >= W.threshold ? W.consistency : 0;

            var delta = deltaByPseudo[pseudo] || 0;
            var gloryBonus = (delta > 0 && maxDelta > 0) ? (delta / maxDelta) * W.gloryMax : 0;

            var totalScore = eventsScore + gloryBonus + consistencyBonus;

            return {
                pseudo:           pseudo,
                score:            round1(totalScore),
                events_score:     round1(eventsScore),
                events_done:      eventsAttended,
                events_total:     eventsTotal,
                attendance_rate:  attendanceRate,
                glory_delta:      delta,
                glory_bonus:      round1(gloryBonus),
                consistency_bonus: consistencyBonus,
                breakdown:        perEvent
            };
        }).sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.pseudo.localeCompare(b.pseudo);
        });

        // 5. Max théorique = somme des maxs des événements qui ont tourné + Bg + Bc
        var maxPossible = 0;
        Object.keys(ranEvents).forEach(function (name) {
            maxPossible += maxEventScore(ranEvents[name]);
        });
        maxPossible += W.gloryMax + W.consistency;

        return { scores: scores, maxPossible: round1(maxPossible), ranEvents: ranEvents };
    }

    function round1(n) { return Math.round(n * 10) / 10; }

    // ── Render contrôles ────────────────────────────────────────────────────────
    function renderControls() {
        document.querySelectorAll('.stats-controls').forEach(function (el) {
            var optHtml = allWeeks.map(function (w) {
                return '<option value="' + w + '"' + (w === currentWeek ? ' selected' : '') + '>' + window.RAD.formatWeek(w) + '</option>';
            }).join('');

            el.innerHTML =
                '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap;">' +
                    '<select class="gm-select week-select" style="width:auto; min-width:180px;">' + optHtml + '</select>' +
                '</div>';

            el.querySelector('.week-select').addEventListener('change', function () {
                currentWeek = this.value;
                refreshData();
            });
        });

        // Tabs-pill rendu dans la zone leaderboard (au-dessus du leaderboard)
        renderModeTabs();
    }

    function renderModeTabs() {
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (container) {
            // Sera ajouté au début du innerHTML au prochain renderLeaderboard
        });
    }

    // ── Render leaderboard ──────────────────────────────────────────────────────
    function renderLeaderboard(opts) {
        var mode = opts && opts.mode;
        var maxPossible = (opts && opts.maxPossible) || 1;
        var modes = [
            { key: 'global', label: t('stats_tab_global'),  icon: 'ph-globe' },
            { key: 'SvS',    label: t('stats_tab_svs'),     icon: 'ph-sword' },
            { key: 'GvG',    label: t('stats_tab_gvg'),     icon: 'ph-flag-banner' },
            { key: 'prince', label: t('stats_tab_prince'),  icon: 'ph-crown' }
        ];

        document.querySelectorAll('.stats-leaderboard-area').forEach(function (container) {
            var tabsHtml = '<div class="gm-tabs-pill" style="margin-bottom:1rem;">' +
                modes.map(function (m) {
                    return '<button class="gm-tab-pill' + (currentMode === m.key ? ' gm-active' : '') + '" data-gm-mode="' + m.key + '">' +
                        '<i class="ph ' + m.icon + '"></i> ' + m.label + '</button>';
                }).join('') +
            '</div>';

            if (!leaderboardData.length) {
                container.innerHTML = tabsHtml +
                    '<div class="gm-empty"><i class="ph-duotone ph-chart-bar gm-icon"></i><div class="gm-empty-title">' + t('stats_no_data') + '</div></div>';
                wireStatsTabs(container);
                return;
            }

            var isEvent = mode === 'event';

            var bannerHtml = '';
            if (mode === 'prince' && opts.range) {
                bannerHtml =
                    '<div class="gm-prince-banner">' +
                        '<i class="ph-fill ph-crown"></i> ' +
                        '<span>' + t('stats_prince_banner') + ' : ' +
                            window.RAD.formatWeek(opts.range.from) + ' → ' + window.RAD.formatWeek(opts.range.to) +
                        '</span>' +
                    '</div>';
            }
            if (!isEvent) {
                bannerHtml += '<div class="gm-formula-note">' +
                    '<i class="ph ph-info"></i> ' + t('stats_max_possible') + ' : <strong>' + fmt(maxPossible) + '</strong> ' + t('stats_points') +
                '</div>';
            }

            // Podium top 3 — silver(2), gold(1), bronze(3)
            var top = leaderboardData.slice(0, Math.min(3, leaderboardData.length));
            var podOrder = top.length >= 3 ? [
                { item: top[1], rank: 2, cls: 'gm-silver' },
                { item: top[0], rank: 1, cls: 'gm-gold' },
                { item: top[2], rank: 3, cls: 'gm-bronze' }
            ] : top.length === 2 ? [
                { item: top[1], rank: 2, cls: 'gm-silver' },
                { item: top[0], rank: 1, cls: 'gm-gold' }
            ] : [{ item: top[0], rank: 1, cls: 'gm-gold' }];

            var podHtml = '<div class="gm-podium">';
            podOrder.forEach(function (slot) {
                var m = slot.item;
                var initial = window.RAD.avatarInit(m.pseudo);
                var scoreDisplay = fmt(m.score) + ' ' + t('stats_pts');
                podHtml +=
                    '<div class="gm-podium-slot ' + slot.cls + '" data-pseudo="' + esc(m.pseudo) + '">' +
                        '<div class="gm-avatar gm-avatar-lg">' + esc(initial) + '</div>' +
                        '<div class="gm-podium-name">' + esc(m.pseudo) + '</div>' +
                        '<div class="gm-podium-score">' + scoreDisplay + '</div>' +
                        '<div class="gm-podium-bar"><div class="gm-podium-rank">' + slot.rank + '</div></div>' +
                    '</div>';
            });
            podHtml += '</div>';

            var tableHtml =
                '<div class="gm-table-wrap"><div class="gm-table-scroll">' +
                '<table class="gm-table gm-resp-table"><thead><tr>' +
                    '<th class="gm-center">#</th>' +
                    '<th>' + t('col_member') + '</th>' +
                    (!isEvent ? '<th class="gm-center">' + t('stats_events') + '</th>' : '') +
                    (!isEvent ? '<th class="gm-center">' + t('stats_glory_delta') + '</th>' : '') +
                    (!isEvent ? '<th class="gm-center">' + t('stats_consistency') + '</th>' : '') +
                    '<th class="gm-right">' + (isEvent ? t('col_score') : t('stats_score_pts')) + '</th>' +
                    '<th class="gm-center">' + t('stats_profile') + '</th>' +
                '</tr></thead><tbody>';

            leaderboardData.forEach(function (m, i) {
                var rank = i + 1;
                var initial = window.RAD.avatarInit(m.pseudo);
                var rankCell = rank <= 3
                    ? '<i class="ph-fill ph-medal" style="color:' + (rank === 1 ? 'oklch(0.78 0.16 75)' : rank === 2 ? 'var(--fg-muted)' : 'oklch(0.65 0.10 50)') + ';"></i>'
                    : rank;

                var consistencyCell = !isEvent
                    ? (m.consistency_bonus > 0
                        ? '<span class="gm-chip gm-chip-success" title="' + Math.round(m.attendance_rate * 100) + '%">+' + m.consistency_bonus + '</span>'
                        : '<span class="gm-dim" title="' + Math.round(m.attendance_rate * 100) + '%">—</span>')
                    : '';

                tableHtml +=
                    '<tr>' +
                        '<td class="gm-center gm-num" data-label="#">' + rankCell + '</td>' +
                        '<td data-label="' + t('col_member') + '">' +
                            '<div class="gm-row" style="gap:.6rem;">' +
                                '<div class="gm-avatar">' + esc(initial) + '</div>' +
                                '<strong>' + esc(m.pseudo) + '</strong>' +
                            '</div>' +
                        '</td>' +
                        (!isEvent ? '<td class="gm-center gm-num" data-label="' + t('stats_events') + '">' + m.events_done + '/' + m.events_total + '</td>' : '') +
                        (!isEvent ? '<td class="gm-center gm-num gm-dim" data-label="' + t('stats_glory_delta') + '">' + (m.glory_delta > 0 ? '+' + fmt(m.glory_delta) : '—') + '</td>' : '') +
                        (!isEvent ? '<td class="gm-center" data-label="' + t('stats_consistency') + '">' + consistencyCell + '</td>' : '') +
                        '<td class="gm-right gm-num" data-label="' + (isEvent ? t('col_score') : t('stats_score_pts')) + '"><strong>' + fmt(m.score) + '</strong></td>' +
                        '<td class="gm-center" data-label="">' +
                            '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm profile-btn" data-pseudo="' + esc(m.pseudo) + '" title="' + t('stats_see_profile') + '">' +
                                '<i class="ph ph-chart-line-up"></i>' +
                            '</button>' +
                        '</td>' +
                    '</tr>';
            });
            tableHtml += '</tbody></table></div></div>';

            container.innerHTML = tabsHtml + bannerHtml + podHtml + tableHtml;

            wireStatsTabs(container);
            container.querySelectorAll('.profile-btn, .gm-podium-slot').forEach(function (btn) {
                btn.addEventListener('click', function () { openProfile(btn.getAttribute('data-pseudo')); });
            });
        });
    }

    function wireStatsTabs(container) {
        container.querySelectorAll('[data-gm-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                currentMode = btn.getAttribute('data-gm-mode');
                refreshData();
            });
        });
    }

    function renderEmpty() {
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (el) {
            el.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-chart-bar"></i><p>' + t('stats_no_data') + '</p></div>';
        });
    }

    // ── Profil membre : historique semaine par semaine + breakdown courant ─────
    async function openProfile(pseudo) {
        var [membersRes, partsRes, gloryRes] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*').neq('event_name', 'Glory').limit(100000),
            db.from('event_participants').select('pseudo, score, week_start').eq('event_name', 'Glory').limit(100000)
        ]);
        var allMembers = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var allParts   = partsRes.data || [];
        var allGlory   = gloryRes.data || [];

        var weeks = Array.from(new Set(allParts.map(function (r) { return r.week_start; }))).sort();
        var glorySpan = (function () {
            var allWeeks = Array.from(new Set(allGlory.map(function (r) { return r.week_start; })));
            return allWeeks.sort();
        })();

        var history = weeks.map(function (w) {
            var weekParts = allParts.filter(function (r) { return r.week_start === w; });
            var prev = window.RAD.getPrevWeekStart(w);
            var glorySpanW = [prev, w];
            var gloryByWeek = buildGloryByWeek(allGlory.filter(function (r) {
                return glorySpanW.indexOf(r.week_start) !== -1;
            }), glorySpanW);
            var result = computeScores(allMembers, weekParts, gloryByWeek, [w]);
            var found = result.scores.find(function (s) { return s.pseudo === pseudo; });
            return found ? Object.assign({ week_start: w, max_possible: result.maxPossible }, found)
                         : { week_start: w, score: 0, events_done: 0, events_total: 0, glory_delta: 0, max_possible: result.maxPossible };
        }).filter(function (r) { return r.events_total > 0 || r.glory_delta > 0; });

        renderProfileModal(pseudo, history);
    }

    function renderProfileModal(pseudo, history) {
        var existing = document.getElementById('profile-modal');
        if (existing) existing.remove();

        var avg  = history.length ? round1(history.reduce(function (s, r) { return s + r.score; }, 0) / history.length) : 0;
        var best = history.length ? round1(Math.max.apply(null, history.map(function (r) { return r.score; }))) : 0;
        var trend = history.length >= 2
            ? round1(history[history.length - 1].score - history[history.length - 2].score)
            : null;
        var trendHtml = trend !== null
            ? '<span class="stat-chip ' + (trend >= 0 ? 'success' : 'muted') + '">' +
              (trend >= 0 ? '↑' : '↓') + ' ' + Math.abs(trend) + ' ' + t('stats_pts') + '</span>'
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
                            '<span class="stat-chip accent"><i class="ph-fill ph-trophy"></i> ' + t('stats_avg') + ' ' + fmt(avg) + '</span>' +
                            '<span class="stat-chip success"><i class="ph-fill ph-star"></i> ' + t('stats_best') + ' ' + fmt(best) + '</span>' +
                            '<span class="stat-chip"><i class="ph-fill ph-calendar"></i> ' + history.length + ' ' + t('stats_weeks') + '</span>' +
                            trendHtml +
                        '</div>' +
                    '</div>' +
                    '<button class="icon-btn profile-close" title="' + t('close_title') + '"><i class="ph ph-x"></i></button>' +
                '</div>';

        if (history.length >= 2) {
            html += '<div class="profile-sparkline">' + buildSparkline(
                history.map(function (r) { return r.score; }),
                history.map(function (r) { return r.week_start; }),
                history[0].max_possible || 0
            ) + '</div>';
        }

        // Décomposition de la dernière semaine
        var last = history[history.length - 1];
        if (last && last.breakdown) {
            html += '<div class="profile-breakdown">' +
                '<h4><i class="ph ph-list-checks"></i> ' + t('stats_breakdown') + ' — ' + window.RAD.formatWeek(last.week_start) + '</h4>' +
                '<table class="leaderboard-table"><thead><tr>' +
                    '<th>' + t('stats_event') + '</th>' +
                    '<th class="center">' + t('stats_coeff') + '</th>' +
                    '<th class="center">' + t('stats_participated') + '</th>' +
                    '<th class="center">' + t('stats_event_score') + '</th>' +
                    '<th class="center">' + t('stats_pts_earned') + '</th>' +
                '</tr></thead><tbody>';

            Object.keys(last.breakdown).forEach(function (name) {
                var b = last.breakdown[name];
                html +=
                    '<tr>' +
                        '<td>' + esc(name) + '</td>' +
                        '<td class="center">×' + b.coeff + '</td>' +
                        '<td class="center">' + (b.participated ? '✅' : '⛔') + '</td>' +
                        '<td class="center">' + (b.score > 0 ? fmt(b.score) : '—') + '</td>' +
                        '<td class="center"><strong>' + fmt(b.total) + '</strong> / ' + fmt(b.max) + '</td>' +
                    '</tr>';
            });

            html +=
                    '<tr class="breakdown-bonus">' +
                        '<td colspan="4">' + t('stats_glory_bonus') + ' (Δ ' + (last.glory_delta > 0 ? '+' : '') + fmt(last.glory_delta) + ')</td>' +
                        '<td class="center"><strong>+' + fmt(last.glory_bonus) + '</strong> / 20</td>' +
                    '</tr>' +
                    '<tr class="breakdown-bonus">' +
                        '<td colspan="4">' + t('stats_consistency_bonus') + ' (' + Math.round(last.attendance_rate * 100) + '%)</td>' +
                        '<td class="center"><strong>+' + fmt(last.consistency_bonus) + '</strong> / 15</td>' +
                    '</tr>' +
                    '<tr class="breakdown-total">' +
                        '<td colspan="4"><strong>' + t('stats_total') + '</strong></td>' +
                        '<td class="center"><strong>' + fmt(last.score) + '</strong> / ' + fmt(last.max_possible) + '</td>' +
                    '</tr>' +
                '</tbody></table></div>';
        }

        // Historique
        html +=
            '<div class="profile-history">' +
            '<h4><i class="ph ph-clock-counter-clockwise"></i> ' + t('stats_history') + '</h4>' +
            '<table class="leaderboard-table"><thead><tr>' +
                '<th>' + t('stats_week') + '</th>' +
                '<th class="center">' + t('stats_score_pts') + '</th>' +
                '<th class="center">' + t('stats_events') + '</th>' +
                '<th class="center">' + t('stats_glory_delta') + '</th>' +
            '</tr></thead><tbody>';

        history.slice().reverse().forEach(function (row) {
            var ratio = row.max_possible > 0 ? row.score / row.max_possible : 0;
            var cls = ratio >= 0.7 ? 'score-high' : ratio >= 0.4 ? 'score-mid' : 'score-low';
            html +=
                '<tr><td class="week-cell">' + window.RAD.formatWeek(row.week_start) + '</td>' +
                '<td class="center"><span class="score-badge ' + cls + '">' + fmt(row.score) + '</span></td>' +
                '<td class="center">' + row.events_done + '/' + row.events_total + '</td>' +
                '<td class="center">' + (row.glory_delta > 0 ? '+' + fmt(row.glory_delta) : '—') + '</td></tr>';
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

    // ── SVG Sparkline (échelle dynamique) ───────────────────────────────────────
    function buildSparkline(scores, weeks, maxPossible) {
        var W_ = 500, H = 100, px = 16, py = 12;
        var n = scores.length;
        var ymax = Math.max(maxPossible || 0, Math.max.apply(null, scores), 1);
        // Round ymax up to a "nice" number
        ymax = niceCeil(ymax);

        var pts = scores.map(function (s, i) {
            var x = px + (n === 1 ? (W_ - px * 2) / 2 : (i / (n - 1)) * (W_ - px * 2));
            var y = H - py - (s / ymax) * (H - py * 2);
            return [x.toFixed(1), y.toFixed(1)];
        });

        var line = pts.map(function (p) { return p.join(','); }).join(' ');
        var area = (px + ',' + (H - py) + ' ') + line + (' ' + (W_ - px) + ',' + (H - py));
        var dots = pts.map(function (p, i) {
            var cls = i === n - 1 ? 'sp-dot sp-dot-last' : 'sp-dot';
            return '<circle class="' + cls + '" cx="' + p[0] + '" cy="' + p[1] + '" r="4"/>';
        }).join('');

        var ticks = [0, ymax / 2, ymax];
        var yLines = ticks.map(function (v) {
            var y = H - py - (v / ymax) * (H - py * 2);
            return '<line x1="' + px + '" x2="' + (W_ - px) + '" y1="' + y + '" y2="' + y + '" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4"/>' +
                   '<text x="' + (px - 4) + '" y="' + (y + 4) + '" text-anchor="end" font-size="9" fill="#64748b">' + Math.round(v) + '</text>';
        }).join('');

        var step = Math.max(1, Math.floor(n / 6));
        var xLabels = pts.filter(function (_, i) { return i % step === 0 || i === n - 1; }).map(function (p, idx) {
            var wi = idx * step;
            if (wi >= n) wi = n - 1;
            var d = new Date(weeks[wi] + 'T12:00:00Z');
            var label = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
            return '<text x="' + p[0] + '" y="' + (H + 2) + '" text-anchor="middle" font-size="9" fill="#64748b">' + label + '</text>';
        }).join('');

        return '<svg viewBox="0 0 ' + W_ + ' ' + (H + 12) + '" class="sparkline-svg" preserveAspectRatio="none">' +
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

    function niceCeil(n) {
        if (n <= 0) return 1;
        var pow = Math.pow(10, Math.floor(Math.log10(n)));
        var f = n / pow;
        var nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
        return nice * pow;
    }

})();
