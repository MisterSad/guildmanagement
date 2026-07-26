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
        return (window.RAD && window.RAD.db) ? window.RAD.db : null;
    }

    function t(key) {
        return (window.RAD && window.RAD.t) ? window.RAD.t(key) : key;
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
        return (window.RAD && window.RAD.formatNumber) ? window.RAD.formatNumber(num) : String(num);
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
    window.RAD_STATS = {
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
            console.warn('[RAD_STATS] Base de données indisponible');
            state.isLoading = false;
            return;
        }

        if (window.RAD && window.RAD.ensureAuthSession) {
            await window.RAD.ensureAuthSession();
        }

        state.activeGuild = window.RAD ? window.RAD.getActiveGuild() : 'ALPHA';
        if (!state.selectedWeek && window.RAD && window.RAD.getWeekStart) {
            state.selectedWeek = window.RAD.getWeekStart();
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
                var defW = window.RAD ? window.RAD.getWeekStart() : '';
                state.allWeeks = defW ? [defW] : [];
                state.selectedWeek = defW;
            }
        } catch (err) {
            console.warn('[RAD_STATS] Erreur fetchAvailableWeeks', err);
            var fallbackW = window.RAD ? window.RAD.getWeekStart() : '';
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
            weeksToLoad = [state.selectedWeek || (window.RAD ? window.RAD.getWeekStart() : '')];
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
            console.error('[RAD_STATS] Erreur loadGlobalMode', err);
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

        // Indexation des participations
        partRows.forEach(function (p) {
            var norm = normalizePseudo(p.pseudo);
            var memberMatch = membersList.find(function (m) { return normalizePseudo(m) === norm; });
            if (!memberMatch) return;

            var agg = aggMap[memberMatch];
            var evName = (p.event_name || '').trim();
            var coeff = COEFFS[evName] || 1;

            if (p.participated > 0) {
                agg.eventsAttended++;
                var baseScore = WEIGHTS.participation * coeff;
                var perfScore = 0;

                if (evName === 'SvS' || evName === 'GvG') {
                    var rawSc = (p.score || 0) + (p.score_prep || 0) + (p.score_pvp || 0);
                    perfScore = rawSc > 0 ? (WEIGHTS.performance * coeff) : 0;
                }

                agg.eventsScore += (baseScore + perfScore);
            }
            agg.eventsTotal++;
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
            console.error('[RAD_STATS] Erreur loadSingleEventMode', err);
            state.leaderboardData = [];
            renderLeaderboard();
        }
    }

    // ── Mode Participation ─────────────────────────────────────────────────────
    async function loadParticipationMode() {
        var db = getDb();
        try {
            var memRes = await db.from('guild_members').select('pseudo').eq('guild', state.activeGuild);
            var partRes = await db.from('event_participants').select('pseudo, participated').eq('guild', state.activeGuild).neq('event_name', 'Glory');

            var memberSet = new Set();
            (memRes.data || []).forEach(function (m) { if (m.pseudo) memberSet.add(m.pseudo); });
            (partRes.data || []).forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });

            var statsByMember = {};
            memberSet.forEach(function (m) {
                statsByMember[m] = { attended: 0, total: 0 };
            });

            (partRes.data || []).forEach(function (r) {
                if (statsByMember[r.pseudo]) {
                    statsByMember[r.pseudo].total++;
                    if (r.participated > 0) statsByMember[r.pseudo].attended++;
                }
            });

            state.leaderboardData = Object.keys(statsByMember).map(function (pseudo) {
                var st = statsByMember[pseudo];
                var rate = st.total > 0 ? st.attended / st.total : 0;
                return {
                    pseudo: pseudo,
                    score: round1(rate * 100),
                    events_done: st.attended,
                    events_total: st.total,
                    attendance_rate: rate,
                    glory_delta: 0,
                    glory_bonus: 0,
                    consistency_bonus: 0
                };
            }).sort(function (a, b) { return b.score - a.score; });

            renderLeaderboard();
        } catch (err) {
            console.error('[RAD_STATS] Erreur loadParticipationMode', err);
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
                return '<option value="' + w + '"' + (w === state.selectedWeek ? ' selected' : '') + '>' + window.RAD.formatWeek(w) + '</option>';
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
            { key: 'participation', label: t('stats_tab_participation') || 'Participation', icon: 'ph-chart-bar' }
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

            // Top 3 Podium avec la DA officielle (.gm-podium, .gm-podium-card, .gm-gold, .gm-silver, .gm-bronze)
            var podHtml = '';
            if (state.leaderboardData.length >= 3) {
                var top1 = state.leaderboardData[0];
                var top2 = state.leaderboardData[1];
                var top3 = state.leaderboardData[2];

                podHtml =
                    '<div class="gm-podium">' +
                        renderPodiumCard(top2, 'silver', '2ND') +
                        renderPodiumCard(top1, 'gold', '<i class="ph-fill ph-crown"></i> 1ST') +
                        renderPodiumCard(top3, 'bronze', '3RD') +
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
                var initial = (window.RAD && window.RAD.avatarInit) ? window.RAD.avatarInit(m.pseudo) : (m.pseudo ? m.pseudo.charAt(0).toUpperCase() : '?');
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

    function renderPodiumCard(member, medalClass, badgeText) {
        if (!member) return '';
        var initial = (window.RAD && window.RAD.avatarInit) ? window.RAD.avatarInit(member.pseudo) : member.pseudo.charAt(0).toUpperCase();
        return '<div class="gm-podium-card gm-' + medalClass + '">' +
            '<span class="gm-podium-badge">' + badgeText + '</span>' +
            '<div class="gm-podium-avatar-wrap">' +
                '<div class="gm-avatar gm-avatar-squircle">' + esc(initial) + '</div>' +
            '</div>' +
            '<div class="gm-podium-info">' +
                '<strong class="gm-podium-name">' + esc(member.pseudo) + '</strong>' +
                '<span class="gm-podium-score-pill">' + fmt(member.score) + ' pts</span>' +
            '</div>' +
        '</div>';
    }

    function wireModeTabs(container) {
        container.querySelectorAll('[data-gm-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.currentMode = btn.getAttribute('data-gm-mode');
                renderControls();
                fetchAndComputeData();
            });
        });
    }

})();
