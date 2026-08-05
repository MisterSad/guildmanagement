/**
 * stats.js — Refonte intégrale From Scratch du moteur de statistiques.
 * 
 * Inclus :
 * - Isolement strict par guilde (Tenant / Guild ID)
 * - Support complet des périodes (Tout l'historique, 1w, 4w, 8w)
 * - Modes Global, SvS, GvG, Prince de la Guerre, et Participation
 * - Résilience réseau et réhydratation automatique des données
 * - Rendu garanti dans les conteneurs .stats-controls et .stats-leaderboard-area
 */
(function () {
    'use strict';

    // ── Helper DB & Traduction ───────────────────────────────────────────────────
    function getDb() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    function t(key) {
        return (window.GM && window.GM.t) ? window.GM.t(key) : key;
    }

    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function fmt(num) {
        if (num == null || isNaN(num)) return '0';
        return (window.GM && window.GM.formatNumber) ? window.GM.formatNumber(num) : String(num);
    }

    function round1(n) {
        return Math.round((n || 0) * 10) / 10;
    }

    function normalizePseudo(p) {
        return p ? String(p).trim().toLowerCase() : '';
    }

    // ── Configuration Formule & Poids ───────────────────────────────────────────
    var COEFFS = {
        'SvS':         5,
        'GvG':         5,
        'Shadowfront': 3,
        'DTR':         2,
        'Arms Race':   1
    };

    var WEIGHTS = {
        participation: 6,
        performance:   4,
        gloryMax:      20,
        consistency:   15,
        threshold:     0.80
    };

    // ── État Interne ─────────────────────────────────────────────────────────────
    var state = {
        activeGuild: 'ALPHA',
        currentMode: 'global', // 'global' | 'SvS' | 'GvG' | 'prince' | 'participation'
        statsPeriod: 'all',    // 'all' | '1w' | '4w' | '8w'
        selectedWeek: '',
        allWeeks: [],
        leaderboardData: [],
        uidMap: {},
        lastMaxPossible: 100,
        isLoading: false
    };

    // ── Public API ──────────────────────────────────────────────────────────────
    window.GM_STATS = {
        load: function () {
            return initAndLoad();
        }
    };

    // ── Initialisation et Chargement ─────────────────────────────────────────────
    async function initAndLoad() {
        if (state.isLoading) return;
        state.isLoading = true;

        var db = getDb();
        if (!db) {
            console.warn('[GM_STATS] Base de données indisponible');
            state.isLoading = false;
            return;
        }

        if (window.GM && window.GM.ensureAuthSession) {
            await window.GM.ensureAuthSession();
        }

        state.activeGuild = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
        if (!state.selectedWeek && window.GM && window.GM.getWeekStart) {
            state.selectedWeek = window.GM.getWeekStart();
        }

        await fetchAvailableWeeks();
        renderControls();
        await fetchAndComputeData();

        state.isLoading = false;
    }

    // ── Récupération des Semaines Disponibles ──────────────────────────────────
    async function fetchAvailableWeeks() {
        var db = getDb();
        if (!db) return;

        try {
            var rpcRes = await db.rpc('list_event_weeks', { p_guild: state.activeGuild });
            var weeks = (rpcRes.data || []).map(function (w) { return w.week_start; }).filter(Boolean);
            weeks.sort(function (a, b) { return b.localeCompare(a); });

            if (weeks.length > 0) {
                state.allWeeks = weeks;
                if (!state.selectedWeek || weeks.indexOf(state.selectedWeek) === -1) {
                    state.selectedWeek = weeks[0];
                }
            } else {
                var defW = window.GM ? window.GM.getWeekStart() : '';
                state.allWeeks = defW ? [defW] : [];
                state.selectedWeek = defW;
            }
        } catch (err) {
            console.warn('[GM_STATS] Erreur fetchAvailableWeeks', err);
            var fallbackW = window.GM ? window.GM.getWeekStart() : '';
            state.allWeeks = fallbackW ? [fallbackW] : [];
            state.selectedWeek = fallbackW;
        }
    }

    // ── Récupération et Calcul des Données ─────────────────────────────────────
    async function fetchAndComputeData() {
        var db = getDb();
        if (!db) return;

        if (state.currentMode === 'participation') {
            await loadParticipationMode();
            return;
        }

        if (state.currentMode === 'SvS' || state.currentMode === 'GvG') {
            await loadSingleEventMode(state.currentMode);
            return;
        }

        // Mode Global / Prince de la Guerre
        var weeksToLoad = state.allWeeks;
        if (state.statsPeriod === '1w') {
            weeksToLoad = [state.selectedWeek];
        } else if (state.statsPeriod === '4w') {
            var idx4 = state.allWeeks.indexOf(state.selectedWeek);
            if (idx4 === -1) idx4 = 0;
            weeksToLoad = state.allWeeks.slice(idx4, idx4 + 4);
        } else if (state.statsPeriod === '8w') {
            var idx8 = state.allWeeks.indexOf(state.selectedWeek);
            if (idx8 === -1) idx8 = 0;
            weeksToLoad = state.allWeeks.slice(idx8, idx8 + 8);
        }

        if (!weeksToLoad || !weeksToLoad.length) {
            weeksToLoad = [state.selectedWeek || (window.GM ? window.GM.getWeekStart() : '')];
        }

        await loadGlobalMode(weeksToLoad);
    }

    // ── Mode Global ─────────────────────────────────────────────────────────────
    async function loadGlobalMode(weeksToLoad) {
        var db = getDb();
        try {
            var isAllTime = (state.statsPeriod === 'all');
            var membersQ = db.from('guild_members').select('pseudo, uid').eq('guild', state.activeGuild);
            var partsQ   = db.from('event_participants').select('*').eq('guild', state.activeGuild).neq('event_name', 'Glory').limit(100000);
            var gloryQ   = db.from('event_participants').select('pseudo, score, week_start').eq('guild', state.activeGuild).eq('event_name', 'Glory').limit(100000);
            var squadsQ  = db.from('shadowfront_squads').select('pseudo, role, week_start').eq('guild', state.activeGuild).limit(100000);

            if (!isAllTime && weeksToLoad && weeksToLoad.length > 0) {
                partsQ = partsQ.in('week_start', weeksToLoad);
                gloryQ = gloryQ.in('week_start', weeksToLoad);
                squadsQ = squadsQ.in('week_start', weeksToLoad);
            }

            var [memRes, partRes, gloryRes, squadRes] = await Promise.all([
                membersQ, partsQ, gloryQ, squadsQ
            ]);

            var memberRows = memRes.data || [];
            var partRows   = partRes.data || [];
            var gloryRows  = gloryRes.data || [];
            var squadRows  = squadRes.data || [];

            // Union de tous les membres uniques
            var memberSet = new Set();
            memberRows.forEach(function (m) { if (m.pseudo) memberSet.add(m.pseudo); });
            partRows.forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });
            gloryRows.forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });
            squadRows.forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });

            var membersList = Array.from(memberSet).sort(function (a, b) { return a.localeCompare(b); });
            state.uidMap = {};
            memberRows.forEach(function (m) { if (m.pseudo) state.uidMap[m.pseudo] = m.uid || ''; });

            // Extraire les semaines effectives
            var actualWeeks = isAllTime
                ? Array.from(new Set(partRows.map(function (r) { return r.week_start; }).concat(gloryRows.map(function (r) { return r.week_start; })).filter(Boolean))).sort()
                : weeksToLoad;

            var computed = computeWeightedScores(membersList, partRows, gloryRows, actualWeeks, squadRows);
            state.leaderboardData = computed.scores;
            state.lastMaxPossible = computed.maxPossible;

            renderLeaderboard();
        } catch (err) {
            console.error('[GM_STATS] Erreur loadGlobalMode', err);
            state.leaderboardData = [];
            renderLeaderboard();
        }
    }

    // ── Calcul des Scores Pondérés ─────────────────────────────────────────────
    function computeWeightedScores(membersList, partRows, gloryRows, weeks, squadRows) {
        var gloryByWeek = {};
        weeks.forEach(function (w) { gloryByWeek[w] = {}; });
        gloryRows.forEach(function (r) {
            if (!gloryByWeek[r.week_start]) gloryByWeek[r.week_start] = {};
            gloryByWeek[r.week_start][normalizePseudo(r.pseudo)] = r.score || 0;
        });

        // Deltas de Gloire
        var weekStarts = Object.keys(gloryByWeek).sort();
        var gloryDeltas = {};
        membersList.forEach(function (pseudo) {
            var norm = normalizePseudo(pseudo);
            var totalDelta = 0;
            for (var i = 1; i < weekStarts.length; i++) {
                var curr = gloryByWeek[weekStarts[i]][norm] || 0;
                var prev = gloryByWeek[weekStarts[i - 1]][norm] || 0;
                var diff = curr - prev;
                if (diff > 0) totalDelta += diff;
            }
            gloryDeltas[pseudo] = totalDelta;
        });
        var maxGloryDelta = Math.max.apply(null, Object.values(gloryDeltas).concat([0]));

        // Aggregation des événements
        var aggMap = {};
        membersList.forEach(function (pseudo) {
            aggMap[pseudo] = {
                eventsScore: 0,
                eventsAttended: 0,
                eventsTotal: 0
            };
        });

        // Indexation des participations par joueur et par instance d'événement unique
        var validPartRows = partRows.filter(function (p) {
            return !p.is_pending;
        });

        // 1. Calculer le nombre total d'événements uniques tenus par cette guilde sur la période
        var tenantEventInstances = new Set();
        validPartRows.forEach(function (p) {
            var evKey = (p.event_name || '').trim() + '|' + (p.session_id || p.week_start || '');
            if (evKey) tenantEventInstances.add(evKey);
        });
        var totalTenantEvents = tenantEventInstances.size;

        var attendedSessionsByMember = {};
        membersList.forEach(function (pseudo) {
            var norm = normalizePseudo(pseudo);
            attendedSessionsByMember[norm] = new Set();
        });

        validPartRows.forEach(function (p) {
            var norm = normalizePseudo(p.pseudo);
            var memberMatch = membersList.find(function (m) { return normalizePseudo(m) === norm; });
            if (!memberMatch) return;

            var agg = aggMap[memberMatch];
            var evName = (p.event_name || '').trim();
            var coeff = COEFFS[evName] || 1;
            var evKey = evName + '|' + (p.session_id || p.week_start || '');

            var attended = (p.participated > 0) || (p.score > 0) || (p.score_prep > 0) || (p.score_pvp > 0);

            if (attended) {
                if (!attendedSessionsByMember[norm].has(evKey)) {
                    attendedSessionsByMember[norm].add(evKey);
                    agg.eventsAttended++;

                    var baseScore = WEIGHTS.participation * coeff;
                    var perfScore = 0;

                    if (evName === 'SvS' || evName === 'GvG') {
                        var rawSc = (p.score || 0) + (p.score_prep || 0) + (p.score_pvp || 0);
                        perfScore = rawSc > 0 ? (WEIGHTS.performance * coeff) : 0;
                    }

                    agg.eventsScore += (baseScore + perfScore);
                }
            }
        });

        // Assigner le nombre total d'événements unique de la guilde à chaque membre
        membersList.forEach(function (pseudo) {
            if (aggMap[pseudo]) {
                aggMap[pseudo].eventsTotal = totalTenantEvents;
            }
        });

        var scores = membersList.map(function (pseudo) {
            var agg = aggMap[pseudo] || { eventsScore: 0, eventsAttended: 0, eventsTotal: 0 };
            var attRate = agg.eventsTotal > 0 ? agg.eventsAttended / agg.eventsTotal : 0;
            var consistencyBonus = attRate >= WEIGHTS.threshold ? (WEIGHTS.consistency * Math.max(1, weeks.length)) : 0;

            var delta = gloryDeltas[pseudo] || 0;
            var gloryBonus = (delta > 0 && maxGloryDelta > 0) ? (delta / maxGloryDelta) * WEIGHTS.gloryMax * Math.max(1, weeks.length) : 0;

            var totalScore = agg.eventsScore + gloryBonus + consistencyBonus;

            return {
                pseudo: pseudo,
                score: round1(totalScore),
                events_score: round1(agg.eventsScore),
                events_done: agg.eventsAttended,
                events_total: agg.eventsTotal,
                attendance_rate: attRate,
                glory_delta: delta,
                glory_bonus: round1(gloryBonus),
                consistency_bonus: consistencyBonus
            };
        }).sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.pseudo.localeCompare(b.pseudo);
        });

        var maxPossibleScore = round1((WEIGHTS.participation + WEIGHTS.performance + WEIGHTS.gloryMax + WEIGHTS.consistency) * Math.max(1, weeks.length) * 5);
        return { scores: scores, maxPossible: maxPossibleScore };
    }

    // ── Mode Evénement Unique (SvS / GvG) ──────────────────────────────────────
    async function loadSingleEventMode(eventName) {
        var db = getDb();
        try {
            var q = db.from('event_participants')
                .select('pseudo, score, score_prep, score_pvp, participated')
                .eq('guild', state.activeGuild)
                .eq('event_name', eventName);

            if (state.statsPeriod !== 'all' && state.selectedWeek) {
                q = q.eq('week_start', state.selectedWeek);
            }

            var res = await q;
            var rows = res.data || [];

            state.leaderboardData = rows.map(function (r) {
                var total = (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0);
                return {
                    pseudo: r.pseudo,
                    score: total,
                    events_done: r.participated > 0 ? 1 : 0,
                    events_total: 1,
                    attendance_rate: r.participated > 0 ? 1 : 0,
                    glory_delta: 0,
                    glory_bonus: 0,
                    consistency_bonus: 0
                };
            }).sort(function (a, b) { return b.score - a.score; });

            renderLeaderboard();
        } catch (err) {
            console.error('[GM_STATS] Erreur loadSingleEventMode', err);
            state.leaderboardData = [];
            renderLeaderboard();
        }
    }

    // ── Mode Participation ─────────────────────────────────────────────────────
    async function loadParticipationMode() {
        var db = getDb();
        try {
            var memRes = await db.from('guild_members').select('pseudo').eq('guild', state.activeGuild);
            var partRes = await db.from('event_participants')
                .select('pseudo, event_name, week_start, session_id, participated, is_pending')
                .eq('guild', state.activeGuild)
                .neq('event_name', 'Glory');

            var memberSet = new Set();
            (memRes.data || []).forEach(function (m) { if (m.pseudo) memberSet.add(m.pseudo); });
            (partRes.data || []).forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });

            var membersList = Array.from(memberSet).sort(function (a, b) { return a.localeCompare(b); });
            var validRows = (partRes.data || []).filter(function (r) { return !r.is_pending; });

            // Unique tenant event instances
            var tenantEventInstances = new Set();
            validRows.forEach(function (r) {
                var evKey = (r.event_name || '').trim() + '|' + (r.session_id || r.week_start || '');
                if (evKey) tenantEventInstances.add(evKey);
            });
            var totalTenantEvents = tenantEventInstances.size;

            var attendedSessionsByMember = {};
            membersList.forEach(function (m) {
                var norm = normalizePseudo(m);
                attendedSessionsByMember[norm] = new Set();
            });

            validRows.forEach(function (r) {
                var norm = normalizePseudo(r.pseudo);
                if (attendedSessionsByMember[norm]) {
                    var evKey = (r.event_name || '').trim() + '|' + (r.session_id || r.week_start || '');
                    if (r.participated > 0) {
                        attendedSessionsByMember[norm].add(evKey);
                    }
                }
            });

            state.leaderboardData = membersList.map(function (pseudo) {
                var norm = normalizePseudo(pseudo);
                var attendedCount = attendedSessionsByMember[norm] ? attendedSessionsByMember[norm].size : 0;
                var rate = totalTenantEvents > 0 ? attendedCount / totalTenantEvents : 0;
                return {
                    pseudo: pseudo,
                    score: round1(rate * 100),
                    events_done: attendedCount,
                    events_total: totalTenantEvents,
                    attendance_rate: rate,
                    glory_delta: 0,
                    glory_bonus: 0,
                    consistency_bonus: 0
                };
            }).sort(function (a, b) { return b.score - a.score; });

            renderLeaderboard();
        } catch (err) {
            console.error('[GM_STATS] Erreur loadParticipationMode', err);
            state.leaderboardData = [];
            renderLeaderboard();
        }
    }

    // ── Render Contrôles (Selecteur Semaine & Période) ─────────────────────────
    function renderControls() {
        var containers = document.querySelectorAll('.stats-controls');
        if (!containers || !containers.length) return;

        containers.forEach(function (el) {
            if (state.currentMode === 'participation') {
                el.innerHTML = '';
                return;
            }

            var weekOpts = state.allWeeks.map(function (w) {
                return '<option value="' + w + '"' + (w === state.selectedWeek ? ' selected' : '') + '>' + window.GM.formatWeek(w) + '</option>';
            }).join('');

            var periodOpts = [
                { key: 'all', label: t('stats_period_all') || 'All Time (Total)' },
                { key: '1w',  label: t('stats_period_1w')  || '1 Week' },
                { key: '4w',  label: t('stats_period_4w')  || '4 Weeks' },
                { key: '8w',  label: t('stats_period_8w')  || '8 Weeks' }
            ].map(function (p) {
                return '<option value="' + p.key + '"' + (p.key === state.statsPeriod ? ' selected' : '') + '>' + esc(p.label) + '</option>';
            }).join('');

            el.innerHTML =
                '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; align-items:center;">' +
                    '<select class="gm-select week-select" style="width:auto; min-width:180px;">' + weekOpts + '</select>' +
                    '<select class="gm-select period-select" style="width:auto; min-width:150px;">' + periodOpts + '</select>' +
                '</div>';

            var weekSelect = el.querySelector('.week-select');
            if (weekSelect) {
                weekSelect.addEventListener('change', function () {
                    state.selectedWeek = this.value;
                    fetchAndComputeData();
                });
            }

            var periodSelect = el.querySelector('.period-select');
            if (periodSelect) {
                periodSelect.addEventListener('change', function () {
                    state.statsPeriod = this.value;
                    fetchAndComputeData();
                });
            }
        });
    }

    // ── Render Leaderboard (Onglets Mode, Podium DA, Tableau DA) ───────────────
    function renderLeaderboard() {
        var containers = document.querySelectorAll('.stats-leaderboard-area');
        if (!containers || !containers.length) return;

        var modes = [
            { key: 'global',        label: t('stats_tab_global')        || 'Global', icon: 'ph-globe' },
            { key: 'SvS',           label: t('stats_tab_svs')           || 'SvS', icon: 'ph-sword' },
            { key: 'GvG',           label: t('stats_tab_gvg')           || 'GvG', icon: 'ph-flag-banner' },
            { key: 'participation', label: t('stats_tab_participation') || 'Participation', icon: 'ph-chart-bar' },
            { key: 'kpi-health',    label: 'Guild Health', icon: 'ph-heartbeat' },
            { key: 'kpi-engage',    label: 'Engagement', icon: 'ph-users-three' },
            { key: 'kpi-roster',    label: 'Roster', icon: 'ph-user-list' },
            { key: 'kpi-ops',       label: 'Operations', icon: 'ph-gear-six' }
        ];

        var tabsHtml = '<div class="gm-tabs-pill" style="margin-bottom:1.25rem; display:flex; gap:.5rem; flex-wrap:wrap;">' +
            modes.map(function (m) {
                return '<button class="gm-tab-pill' + (state.currentMode === m.key ? ' gm-active' : '') + '" data-gm-mode="' + m.key + '">' +
                    '<i class="ph ' + m.icon + '"></i> ' + m.label + '</button>';
            }).join('') +
        '</div>';

        containers.forEach(function (container) {
            if (!state.leaderboardData || !state.leaderboardData.length) {
                container.innerHTML = tabsHtml +
                    '<div class="gm-empty" style="padding:3.5rem 1.5rem; text-align:center; background:var(--bg-1); border-radius:var(--radius-xl); border:1px dashed var(--border-soft); margin-top:1rem;">' +
                        '<i class="ph-duotone ph-chart-bar gm-icon" style="font-size:2.8rem; color:var(--fg-dim); margin-bottom:.5rem; display:block;"></i>' +
                        '<div class="gm-empty-title" style="font-size:1.15rem; font-weight:700; color:var(--fg);">' + (t('stats_no_data') || 'No statistics available for this selection.') + '</div>' +
                    '</div>';
                wireModeTabs(container);
                return;
            }

            // Top 3 3D Cylindrical Podium Stage (Inspired by Mockup)
            var podHtml = '';
            if (state.leaderboardData.length >= 3) {
                var top1 = state.leaderboardData[0];
                var top2 = state.leaderboardData[1];
                var top3 = state.leaderboardData[2];

                podHtml =
                    '<div class="gm-podium-stage-container">' +
                        '<div class="gm-podium-stage">' +
                            render3DPodiumColumn(top2, 'silver', '2') +
                            render3DPodiumColumn(top1, 'gold', '1') +
                            render3DPodiumColumn(top3, 'bronze', '3') +
                        '</div>' +
                        '<div class="gm-stats-leaderboard-banner">' +
                            '<h3>CLIMB THE LEADERBOARD &amp; CLAIM GUILD GLORY</h3>' +
                            '<p>Track live attendance, weekly score gains, and top guild contributors.</p>' +
                        '</div>' +
                    '</div>';
            }

            // Tableau de Classement Officiel (.gm-card, .glass-card, .gm-table)
            var tableHtml =
                '<div class="gm-card glass-card" style="padding:1.25rem;">' +
                    '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                        '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                            '<thead><tr>' +
                                '<th class="gm-center" style="width:65px;">#</th>' +
                                '<th>' + (t('col_member') || 'Member') + '</th>' +
                                '<th class="gm-center">' + (t('stats_events') || 'Events') + '</th>' +
                                '<th class="gm-center">' + (t('stats_glory_delta') || 'Glory Δ') + '</th>' +
                                '<th class="gm-right">' + (t('stats_score_pts') || 'Score Pts') + '</th>' +
                            '</tr></thead><tbody>';

            state.leaderboardData.forEach(function (m, idx) {
                var rank = idx + 1;
                var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(m.pseudo) : (m.pseudo ? m.pseudo.charAt(0).toUpperCase() : '?');
                var rankBadge = rank === 1 ? '<span class="gm-rank-badge">🥇</span>' : rank === 2 ? '<span class="gm-rank-badge">🥈</span>' : rank === 3 ? '<span class="gm-rank-badge">🥉</span>' : '<span class="gm-rank-num">' + rank + '</span>';

                tableHtml +=
                    '<tr style="border-bottom:1px solid var(--border-soft);">' +
                        '<td class="gm-center" style="font-weight:700;">' + rankBadge + '</td>' +
                        '<td>' +
                            '<div class="gm-member-id" style="display:flex; align-items:center; gap:.75rem;">' +
                                '<div class="gm-avatar gm-avatar-squircle" style="width:38px; height:38px; font-size:1rem; font-weight:700;">' + esc(initial) + '</div>' +
                                '<strong class="gm-member-pseudo" style="color:var(--fg); font-weight:700;">' + esc(m.pseudo) + '</strong>' +
                            '</div>' +
                        '</td>' +
                        '<td class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + m.events_done + '/' + m.events_total + '</td>' +
                        '<td class="gm-center" style="color:var(--fg-dim); font-variant-numeric:tabular-nums;">' + (m.glory_delta > 0 ? '+' + fmt(m.glory_delta) : '—') + '</td>' +
                        '<td class="gm-right" style="font-family:var(--font-display); font-weight:800; color:var(--accent-lime); font-size:1.05rem;"><span class="gm-score-display">' + fmt(m.score) + ' pts</span></td>' +
                    '</tr>';
            });

            tableHtml += '</tbody></table></div></div>';

            container.innerHTML = tabsHtml + podHtml + tableHtml;
            wireModeTabs(container);
        });
    }

    function render3DPodiumColumn(member, medalClass, rankNum) {
        if (!member) return '';
        var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(member.pseudo) : (member.pseudo ? member.pseudo.charAt(0).toUpperCase() : '?');
        return '<div class="gm-podium-column gm-' + medalClass + '">' +
            '<div class="gm-podium-avatar-hex">' +
                '<div class="gm-avatar">' + esc(initial) + '</div>' +
            '</div>' +
            '<div class="gm-podium-player-name">' + esc(member.pseudo) + '</div>' +
            '<div class="gm-podium-score-val">' + fmt(member.score) + ' pts</div>' +
            '<div class="gm-podium-pedestal">' +
                '<div class="gm-podium-pedestal-top"></div>' +
                '<div class="gm-podium-hex-rank">' + rankNum + '</div>' +
            '</div>' +
        '</div>';
    }

    // ── KPI: Guild Health (power macro view) ──────────────────────────────────
    async function renderKpiHealth(container, db, g, tabsHtml) {
        var membersRes = await db.from('guild_members').select('pseudo, overall_power, role, created_at').eq('guild', g);
        var members = membersRes.data || [];
        var totalPower = members.reduce(function (a, m) { return a + (parseInt(m.overall_power, 10) || 0); }, 0);
        var active = members.filter(function (m) { return (parseInt(m.overall_power, 10) || 0) > 0; });
        var avgPower = active.length > 0 ? Math.round(totalPower / active.length) : 0;

        // Power tiers (S/A/B/C/D) relative to guild max
        var maxPower = members.reduce(function (a, m) { return Math.max(a, parseInt(m.overall_power, 10) || 0); }, 0);
        var tiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };
        members.forEach(function (m) {
            var tier = window.GM.getPowerTier(m.overall_power, maxPower);
            if (tiers[tier] !== undefined) tiers[tier]++;
        });

        // Concentration: % of power held by top 5 / top 10
        var sorted = active.slice().sort(function (a, b) { return (parseInt(b.overall_power, 10) || 0) - (parseInt(a.overall_power, 10) || 0); });
        var pct = function (n) {
            if (totalPower <= 0) return 0;
            return Math.round(sorted.slice(0, n).reduce(function (a, m) { return a + (parseInt(m.overall_power, 10) || 0); }, 0) / totalPower * 100);
        };
        var top5 = pct(5), top10 = pct(10);

        // Tier distribution bars
        var tierOrder = ['S', 'A', 'B', 'C', 'D'];
        var tierColors = { S: '#fbbf24', A: '#f87171', B: '#c084fc', C: '#60a5fa', D: '#34d399' };
        var maxTier = 0;
        tierOrder.forEach(function (k) { if (tiers[k] > maxTier) maxTier = tiers[k]; });
        var tierBars = tierOrder.map(function (k) {
            var pctW = maxTier > 0 ? Math.round(tiers[k] / maxTier * 100) : 0;
            return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + k + '</span>' +
                '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pctW + '%; background:' + tierColors[k] + ';"></div></div>' +
                '<span class="gm-kpi-value">' + tiers[k] + '</span></div>';
        }).join('');

        var html = tabsHtml +
            '<div class="gm-kpi-grid">' +
                kpiTile('Total Power', formatBigNum(totalPower), 'ph-gauge', 'stat-theme-cyan') +
                kpiTile('Avg Power (active)', formatBigNum(avgPower), 'ph-chart-line', 'stat-theme-lime') +
                kpiTile('Top 5 share', top5 + '%', 'ph-crown', top5 > 60 ? 'stat-theme-coral' : 'stat-theme-mint') +
                kpiTile('Top 10 share', top10 + '%', 'ph-chart-pie', top10 > 80 ? 'stat-theme-coral' : 'stat-theme-mint') +
            '</div>' +
            '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-chart-pie"></i> Power distribution by tier</div>' +
                '<div class="gm-kpi-card-body">' + tierBars + '</div>' +
            '</div>' +
            '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-user-list"></i> Roster summary</div>' +
                '<div class="gm-kpi-card-body"><div class="gm-kpi-inline">' +
                    kpiMini('Members', members.length) + kpiMini('With power', active.length) + kpiMini('No power (0)', members.length - active.length) +
                '</div></div>' +
            '</div>';

        container.innerHTML = html;
        wireModeTabs(container);
    }

    // ── KPI: Engagement ───────────────────────────────────────────────────────
    async function renderKpiEngagement(container, db, g, tabsHtml) {
        // Participation per week (last 8 weeks)
        var partsRes = await db.from('event_participants')
            .select('pseudo, event_name, week_start, participated')
            .eq('guild', g)
            .neq('event_name', 'Glory');
        var rows = partsRes.data || [];

        var weeks = [];
        rows.forEach(function (r) { if (r.week_start && weeks.indexOf(r.week_start) === -1) weeks.push(r.week_start); });
        weeks.sort(function (a, b) { return b.localeCompare(a); });
        var last8 = weeks.slice(0, 8).reverse();

        var perWeek = {};
        last8.forEach(function (w) {
            var wkRows = rows.filter(function (r) { return r.week_start === w; });
            var present = wkRows.filter(function (r) { return r.participated > 0; }).length;
            perWeek[w] = {
                total: wkRows.length,
                present: present,
                rate: wkRows.length > 0 ? Math.round(present / wkRows.length * 100) : 0
            };
        });

        // Inactive members: 0 participation in the last 2 weeks
        var cutoff = (window.GM && window.GM.getWeekStart) ? window.GM.getWeekStart() : '';
        var weeksAgo2 = window.GM && window.GM.getPrevWeekStart ? window.GM.getPrevWeekStart() : cutoff;
        var activePseudos = {};
        rows.forEach(function (r) {
            if (r.week_start >= weeksAgo2) activePseudos[r.pseudo] = true;
        });
        var membersRes = await db.from('guild_members').select('pseudo, overall_power').eq('guild', g);
        var members = membersRes.data || [];
        var inactive = members.filter(function (m) { return !activePseudos[m.pseudo]; });

        // Reliability: declared available (shadowfront_signups) but absent
        var signupsRes = await db.from('shadowfront_signups').select('pseudo, week_start, availability').eq('guild', g);
        var signups = signupsRes.data || [];
        var declared = {};
        signups.forEach(function (s) {
            if (s.availability === 'squad1' || s.availability === 'squad2' || s.availability === 'both') {
                declared[s.pseudo] = true;
            }
        });
        var reliability = { declared: 0, present: 0 };
        Object.keys(declared).forEach(function (p) {
            reliability.declared++;
            if (activePseudos[p]) reliability.present++;
        });
        var relRate = reliability.declared > 0 ? Math.round(reliability.present / reliability.declared * 100) : 0;

        // Week bars
        var maxRate = 0;
        last8.forEach(function (w) { if (perWeek[w].rate > maxRate) maxRate = perWeek[w].rate; });
        if (maxRate <= 0) maxRate = 1;
        var weekBars = last8.map(function (w) {
            var d = perWeek[w];
            var pctW = Math.round(d.rate / maxRate * 100);
            return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + shortDate(w) + '</span>' +
                '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pctW + '%; background:#a78bfa;"></div></div>' +
                '<span class="gm-kpi-value">' + d.present + '/' + d.total + ' (' + d.rate + '%)</span></div>';
        }).join('');

        var inactiveHtml = inactive.length === 0
            ? '<div class="gm-empty" style="padding:1rem;">All members participated recently.</div>'
            : inactive.slice(0, 15).map(function (m) {
                return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + esc(m.pseudo) + '</span><span class="gm-kpi-value">' + (parseInt(m.overall_power, 10) || 0) + ' power</span></div>';
            }).join('') + (inactive.length > 15 ? '<div class="gm-kpi-row"><span class="gm-kpi-label">...</span></div>' : '');

        var html = tabsHtml +
            '<div class="gm-kpi-grid">' +
                kpiTile('2-week inactive', inactive.length, 'ph-user-minus', inactive.length > 0 ? 'stat-theme-coral' : 'stat-theme-mint') +
                kpiTile('Dispo reliability', relRate + '%', 'ph-shield-check', relRate >= 70 ? 'stat-theme-lime' : relRate >= 40 ? 'stat-theme-coral' : 'stat-theme-lilac') +
                kpiTile('Declared available', reliability.declared, 'ph-users', 'stat-theme-cyan') +
                kpiTile('Weeks tracked', last8.length, 'ph-calendar', 'stat-theme-mint') +
            '</div>' +
            '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-chart-line-up"></i> Participation rate per week</div>' +
                '<div class="gm-kpi-card-body">' + weekBars + '</div>' +
            '</div>' +
            '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-user-minus"></i> Inactive members (no participation in 2 weeks)</div>' +
                '<div class="gm-kpi-card-body">' + inactiveHtml + '</div>' +
            '</div>';

        container.innerHTML = html;
        wireModeTabs(container);
    }

    // ── KPI: Roster & Retention ───────────────────────────────────────────────
    async function renderKpiRoster(container, db, g, tabsHtml) {
        var membersRes = await db.from('guild_members').select('pseudo, overall_power, role, created_at').eq('guild', g);
        var members = membersRes.data || [];
        var roles = { R5: 0, R4: 0, R3: 0, R2: 0, R1: 0 };
        members.forEach(function (m) { var r = m.role || 'R1'; roles[r] = (roles[r] || 0) + 1; });
        var roleOrder = ['R5', 'R4', 'R3', 'R2', 'R1'];
        var maxRole = 0;
        roleOrder.forEach(function (k) { if (roles[k] > maxRole) maxRole = roles[k]; });
        var roleBars = roleOrder.map(function (k) {
            var pctW = maxRole > 0 ? Math.round(roles[k] / maxRole * 100) : 0;
            return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + k + '</span>' +
                '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pctW + '%; background:#60a5fa;"></div></div>' +
                '<span class="gm-kpi-value">' + roles[k] + '</span></div>';
        }).join('');

        // Tenure buckets (by created_at)
        var now = Date.now();
        var tenure = { '0-1mo': 0, '1-3mo': 0, '3-6mo': 0, '6mo+': 0 };
        members.forEach(function (m) {
            if (!m.created_at) { tenure['0-1mo']++; return; }
            var age = (now - new Date(m.created_at).getTime()) / (30 * 24 * 3600 * 1000);
            if (age < 1) tenure['0-1mo']++;
            else if (age < 3) tenure['1-3mo']++;
            else if (age < 6) tenure['3-6mo']++;
            else tenure['6mo+']++;
        });
        var maxTenure = 0;
        Object.keys(tenure).forEach(function (k) { if (tenure[k] > maxTenure) maxTenure = tenure[k]; });
        var tenureBars = Object.keys(tenure).map(function (k) {
            var pctW = maxTenure > 0 ? Math.round(tenure[k] / maxTenure * 100) : 0;
            return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + k + '</span>' +
                '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pctW + '%; background:#34d399;"></div></div>' +
                '<span class="gm-kpi-value">' + tenure[k] + '</span></div>';
        }).join('');

        // Transfers (net churn)
        var transRes = await db.from('guild_transfers')
            .select('source_guild, target_guild, status, resolved_at')
            .eq('status', 'approved')
            .or('source_guild.eq.' + g + ',target_guild.eq.' + g);
        var transfers = transRes.data || [];
        var incoming = transfers.filter(function (t) { return t.target_guild === g; }).length;
        var outgoing = transfers.filter(function (t) { return t.source_guild === g; }).length;
        var net = incoming - outgoing;

        var html = tabsHtml +
            '<div class="gm-kpi-grid">' +
                kpiTile('Incoming transfers', incoming, 'ph-arrow-down-left', 'stat-theme-mint') +
                kpiTile('Outgoing transfers', outgoing, 'ph-arrow-up-right', 'stat-theme-coral') +
                kpiTile('Net flow', (net >= 0 ? '+' : '') + net, 'ph-swap', net >= 0 ? 'stat-theme-lime' : 'stat-theme-coral') +
                kpiTile('Members', members.length, 'ph-users', 'stat-theme-cyan') +
            '</div>' +
            '<div class="gm-kpi-grid" style="margin-top:0.85rem;">' +
                '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-shield-star"></i> Role structure</div>' +
                    '<div class="gm-kpi-card-body">' + roleBars + '</div></div>' +
                '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-calendar"></i> Tenure</div>' +
                    '<div class="gm-kpi-card-body">' + tenureBars + '</div></div>' +
            '</div>';

        container.innerHTML = html;
        wireModeTabs(container);
    }

    // ── KPI: Operations ───────────────────────────────────────────────────────
    async function renderKpiOperations(container, db, g, tabsHtml) {
        // Pending player score submissions
        var pendingRes = await db.from('event_participants')
            .select('pseudo, event_name, week_start')
            .eq('guild', g)
            .eq('is_pending', true);
        var pending = pendingRes.data || [];

        // Active events (roster completeness proxy: participants imported vs members)
        var membersRes = await db.from('guild_members').select('id').eq('guild', g);
        var memberCount = (membersRes.data || []).length;
        var statusRes = await db.from('event_status').select('event_name, session_id').eq('guild', g).eq('is_active', true);
        var activeEvents = statusRes.data || [];
        var importedRes = await db.from('event_participants')
            .select('session_id', { count: 'exact', head: true })
            .in('session_id', activeEvents.map(function (s) { return s.session_id; }).filter(Boolean));
        var importedCount = importedRes.count || 0;
        var completeness = activeEvents.length > 0 && memberCount > 0 ? Math.min(100, Math.round(importedCount / (activeEvents.length * memberCount) * 100)) : 0;

        // Pending transfers awaiting approval
        var pendingTransRes = await db.from('guild_transfers')
            .select('pseudo, source_guild, created_at')
            .eq('status', 'pending')
            .eq('target_guild', g);
        var pendingTransfers = pendingTransRes.data || [];

        var pendingHtml = pending.length === 0
            ? '<div class="gm-empty" style="padding:1rem;">No pending score submissions.</div>'
            : pending.slice(0, 20).map(function (p) {
                return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + esc(p.pseudo) + '</span><span class="gm-kpi-value">' + esc(p.event_name) + ' (' + shortDate(p.week_start) + ')</span></div>';
            }).join('');

        var transHtml = pendingTransfers.length === 0
            ? '<div class="gm-empty" style="padding:1rem;">No pending transfer requests.</div>'
            : pendingTransfers.slice(0, 10).map(function (t) {
                return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + esc(t.pseudo) + '</span><span class="gm-kpi-value">from ' + esc(t.source_guild) + '</span></div>';
            }).join('');

        var html = tabsHtml +
            '<div class="gm-kpi-grid">' +
                kpiTile('Pending score approvals', pending.length, 'ph-hourglass', pending.length > 0 ? 'stat-theme-coral' : 'stat-theme-mint') +
                kpiTile('Active events', activeEvents.length, 'ph-calendar-dots', 'stat-theme-cyan') +
                kpiTile('Roster completeness', completeness + '%', 'ph-check-circle', completeness >= 80 ? 'stat-theme-lime' : 'stat-theme-coral') +
                kpiTile('Pending transfers', pendingTransfers.length, 'ph-swap', pendingTransfers.length > 0 ? 'stat-theme-lilac' : 'stat-theme-mint') +
            '</div>' +
            '<div class="gm-kpi-grid" style="margin-top:0.85rem;">' +
                '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-hourglass"></i> Pending score submissions</div>' +
                    '<div class="gm-kpi-card-body">' + pendingHtml + '</div></div>' +
                '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-swap"></i> Pending transfer requests</div>' +
                    '<div class="gm-kpi-card-body">' + transHtml + '</div></div>' +
            '</div>';

        container.innerHTML = html;
        wireModeTabs(container);
    }

    // ── KPI helpers ───────────────────────────────────────────────────────────
    function kpiTile(label, value, icon, theme) {
        return '<div class="gm-kpi-tile ' + (theme || '') + '">' +
            '<i class="ph ' + icon + '"></i>' +
            '<div class="gm-kpi-tile-value">' + value + '</div>' +
            '<div class="gm-kpi-tile-label">' + label + '</div>' +
        '</div>';
    }

    function kpiMini(label, value) {
        return '<div class="gm-kpi-mini"><span class="gm-kpi-mini-value">' + value + '</span><span class="gm-kpi-mini-label">' + label + '</span></div>';
    }

    function formatBigNum(n) {
        n = n || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
        return String(n);
    }

    function shortDate(iso) {
        if (!iso) return '—';
        return String(iso).slice(5, 10);
    }

    // ── KPI Tabs (Guild macro view) ───────────────────────────────────────────
    async function renderKpiTab() {
        var containers = document.querySelectorAll('.stats-leaderboard-area');
        if (!containers || !containers.length) return;
        var container = containers[0];
        var mode = state.currentMode;

        // Keep the tab pills rendered on top
        var tabsHtml = '<div class="gm-tabs-pill" style="margin-bottom:1.25rem; display:flex; gap:.5rem; flex-wrap:wrap;">' +
            [
                { key: 'global',        label: t('stats_tab_global')        || 'Global', icon: 'ph-globe' },
                { key: 'SvS',           label: t('stats_tab_svs')           || 'SvS', icon: 'ph-sword' },
                { key: 'GvG',           label: t('stats_tab_gvg')           || 'GvG', icon: 'ph-flag-banner' },
                { key: 'participation', label: t('stats_tab_participation') || 'Participation', icon: 'ph-chart-bar' },
                { key: 'kpi-health',    label: 'Guild Health', icon: 'ph-heartbeat' },
                { key: 'kpi-engage',    label: 'Engagement', icon: 'ph-users-three' },
                { key: 'kpi-roster',    label: 'Roster', icon: 'ph-user-list' },
                { key: 'kpi-ops',       label: 'Operations', icon: 'ph-gear-six' }
            ].map(function (m) {
                return '<button class="gm-tab-pill' + (mode === m.key ? ' gm-active' : '') + '" data-gm-mode="' + m.key + '">' +
                    '<i class="ph ' + m.icon + '"></i> ' + m.label + '</button>';
            }).join('') +
        '</div>';

        container.innerHTML = tabsHtml + '<div class="gm-empty" style="padding:3.5rem 1.5rem;"><i class="ph-duotone ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading guild metrics...</div></div>';
        wireModeTabs(container);

        var db = getDb();
        if (!db) {
            container.innerHTML = tabsHtml + '<div class="gm-empty" style="padding:3rem;"><div class="gm-empty-title">Database unavailable.</div></div>';
            wireModeTabs(container);
            return;
        }

        var g = state.activeGuild;
        try {
            if (mode === 'kpi-health') {
                await renderKpiHealth(container, db, g, tabsHtml);
            } else if (mode === 'kpi-engage') {
                await renderKpiEngagement(container, db, g, tabsHtml);
            } else if (mode === 'kpi-roster') {
                await renderKpiRoster(container, db, g, tabsHtml);
            } else if (mode === 'kpi-ops') {
                await renderKpiOperations(container, db, g, tabsHtml);
            }
        } catch (err) {
            console.error('[GM_STATS] KPI render error', err);
            container.innerHTML = tabsHtml + '<div class="gm-empty" style="padding:3rem;"><div class="gm-empty-title">Failed to load metrics.</div></div>';
            wireModeTabs(container);
        }
    }

    function wireModeTabs(container) {
        container.querySelectorAll('[data-gm-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.currentMode = btn.getAttribute('data-gm-mode');
                renderControls();
                if (state.currentMode.indexOf('kpi-') === 0) {
                    renderKpiTab();
                    return;
                }
                fetchAndComputeData();
            });
        });
    }

})();
