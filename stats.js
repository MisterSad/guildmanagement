/**
 * stats.js — Modern 2026 Executive Statistics & Analytics Engine.
 * 
 * Inclus :
 * - Cockpit Exécutif (Indice de santé globale 0-100%, Puissance, Répartition Tiers)
 * - Détection proactive des membres inactifs (2+ semaines) et Top 5 MVPs
 * - Analyse comparative de présence par type d'événement (SvS, GvG, Shadowfront, Arms Race, DTR, Glory)
 * - Classements individuels complets (Global pondéré, SvS, GvG, Taux de présence)
 * - Podium 3D DA, recherche temps réel, et sélecteurs de périodes (1w, 2w, 4w, 8w, All)
 * - Isolement strict multi-tenant par guilde active
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

    function getWeekNumber(ws) {
        if (!ws) return '';
        var d = new Date(ws.length === 10 ? ws + 'T12:00:00Z' : ws);
        if (isNaN(d.getTime())) return '';
        var target = new Date(d.valueOf());
        var dayNr = (d.getUTCDay() + 6) % 7;
        target.setUTCDate(target.getUTCDate() - dayNr + 3);
        var firstThursday = target.valueOf();
        target.setUTCMonth(0, 1);
        if (target.getUTCDay() !== 4) {
            target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
        }
        return 1 + Math.ceil((firstThursday - target) / 604800000);
    }

    function isFutureWeek(weekStart) {
        if (!weekStart) return false;
        var cur = window.GM ? window.GM.getWeekStart() : '';
        if (!cur) return false;
        return String(weekStart).localeCompare(cur) > 0;
    }

    function keepOnlyPastOrCurrent(rows) {
        if (!rows || !rows.length) return rows;
        return rows.filter(function (r) { return !isFutureWeek(r.week_start); });
    }

    function shortDate(iso) {
        if (!iso) return '-';
        return String(iso).slice(5, 10);
    }

    function formatBigNum(n) {
        n = n || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
        return String(n);
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
        currentMode: 'global', // 'global' | 'SvS' | 'GvG' | 'participation' | 'kpi-health' | 'kpi-engage' | 'kpi-roster' | 'kpi-ops'
        statsPeriod: '1w',     // '1w' | '2w' | '4w' | '8w' | 'all'
        selectedWeek: '',
        searchQuery: '',
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

        // Restore saved mode
        var savedMode = null;
        try { savedMode = localStorage.getItem('gm_stats_mode'); } catch (_) {}
        if (savedMode && state.currentMode !== savedMode) {
            state.currentMode = savedMode;
        }

        await fetchAvailableWeeks();
        renderControls();

        try {
            if (state.currentMode.indexOf('kpi-') === 0) {
                await renderKpiTab();
            } else {
                await fetchAndComputeLeaderboard();
            }
        } catch (err) {
            console.error('[GM_STATS] load error', err);
        }

        state.isLoading = false;
    }

    async function fetchAvailableWeeks() {
        var db = getDb();
        if (!db) return;

        try {
            var rpcRes = await db.rpc('list_event_weeks', { p_guild: state.activeGuild });
            var weeks = (rpcRes.data || []).map(function (w) { return w.week_start; }).filter(Boolean);
            weeks = weeks.filter(function (w) { return !isFutureWeek(w); });
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

    // ── Render Contrôles (Selecteur Semaine & Période) ─────────────────────────
    function renderControls() {
        var containers = document.querySelectorAll('.stats-controls');
        if (!containers || !containers.length) return;

        containers.forEach(function (el) {
            if (state.currentMode === 'participation' || state.currentMode.indexOf('kpi-') === 0) {
                el.innerHTML = '';
                return;
            }

            var weekOpts = state.allWeeks.map(function (w) {
                return '<option value="' + w + '"' + (w === state.selectedWeek ? ' selected' : '') + '>' + (window.GM ? window.GM.formatWeek(w) : w) + '</option>';
            }).join('');

            var periodOpts = [
                { key: '1w',  label: t('stats_period_1w')  || '1 Week' },
                { key: '2w',  label: t('stats_period_2w')  || '2 Weeks' },
                { key: '4w',  label: t('stats_period_4w')  || '4 Weeks' },
                { key: '8w',  label: t('stats_period_8w')  || '8 Weeks' },
                { key: 'all', label: t('stats_period_all') || 'All Time (Total)' }
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
                    fetchAndComputeLeaderboard();
                });
            }

            var periodSelect = el.querySelector('.period-select');
            if (periodSelect) {
                periodSelect.addEventListener('change', function () {
                    state.statsPeriod = this.value;
                    fetchAndComputeLeaderboard();
                });
            }
        });
    }

    // ── Barre de Navigation des Modes ──────────────────────────────────────────
    function getTabsHtml(currentMode) {
        var modes = [
            { key: 'kpi-health',    label: 'Guild Health', icon: 'ph-heartbeat' },
            { key: 'kpi-engage',    label: 'Engagement & Inactive', icon: 'ph-users-three' },
            { key: 'global',        label: t('stats_tab_global') || 'Global Leaderboard', icon: 'ph-trophy' },
            { key: 'SvS',           label: t('stats_tab_svs') || 'SvS Battle', icon: 'ph-sword' },
            { key: 'GvG',           label: t('stats_tab_gvg') || 'GvG War', icon: 'ph-flag-banner' },
            { key: 'participation', label: t('stats_tab_participation') || 'Attendance Rate', icon: 'ph-chart-bar' },
            { key: 'kpi-roster',    label: 'Roster Structure', icon: 'ph-user-list' },
            { key: 'kpi-ops',       label: 'Operations', icon: 'ph-gear-six' }
        ];

        return '<div class="gm-tabs-pill" style="margin-bottom:1.25rem; display:flex; gap:.45rem; flex-wrap:wrap;">' +
            modes.map(function (m) {
                return '<button class="gm-tab-pill' + (currentMode === m.key ? ' gm-active' : '') + '" data-gm-mode="' + m.key + '">' +
                    '<i class="ph ' + m.icon + '"></i> ' + m.label + '</button>';
            }).join('') +
        '</div>';
    }

    function wireModeTabs(container) {
        container.querySelectorAll('[data-gm-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.currentMode = btn.getAttribute('data-gm-mode');
                try { localStorage.setItem('gm_stats_mode', state.currentMode); } catch (_) {}
                renderControls();
                if (state.currentMode.indexOf('kpi-') === 0) {
                    renderKpiTab();
                    return;
                }
                fetchAndComputeLeaderboard();
            });
        });
    }

    // ── 1. LEADERBOARD COMPUTATION & RENDERING ────────────────────────────────────
    async function fetchAndComputeLeaderboard() {
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

        var weeksToLoad = state.allWeeks;
        if (state.statsPeriod === '1w') {
            weeksToLoad = [state.selectedWeek];
        } else if (state.statsPeriod === '2w') {
            var idx2 = state.allWeeks.indexOf(state.selectedWeek);
            if (idx2 === -1) idx2 = 0;
            weeksToLoad = state.allWeeks.slice(idx2, idx2 + 2);
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

    async function loadGlobalMode(weeksToLoad) {
        var db = getDb();
        try {
            var isAllTime = (state.statsPeriod === 'all');
            var dataRes = await db.rpc('gm_stats_data', { p_guild: state.activeGuild });
            var raw = dataRes.data || null;

            var memberRows = (raw && raw.members) || [];
            var partRows   = (raw && raw.participants) || [];
            var gloryRows  = (raw && raw.glory) || [];
            var squadRows  = (raw && raw.squads) || [];

            partRows = keepOnlyPastOrCurrent(partRows);
            gloryRows = keepOnlyPastOrCurrent(gloryRows);
            squadRows = keepOnlyPastOrCurrent(squadRows);

            if (!isAllTime && weeksToLoad && weeksToLoad.length > 0) {
                partRows = partRows.filter(function (r) { return weeksToLoad.indexOf(r.week_start) !== -1; });
                gloryRows = gloryRows.filter(function (r) { return weeksToLoad.indexOf(r.week_start) !== -1; });
                squadRows = squadRows.filter(function (r) { return weeksToLoad.indexOf(r.week_start) !== -1; });
            }

            var memberSet = new Set();
            memberRows.forEach(function (m) { if (m.pseudo) memberSet.add(m.pseudo); });
            partRows.forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });
            gloryRows.forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });
            squadRows.forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });

            var membersList = Array.from(memberSet).sort(function (a, b) { return a.localeCompare(b); });
            state.uidMap = {};
            memberRows.forEach(function (m) { if (m.pseudo) state.uidMap[m.pseudo] = m.uid || ''; });

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

    function computeWeightedScores(membersList, partRows, gloryRows, weeks, squadRows) {
        var gloryByWeek = {};
        weeks.forEach(function (w) { gloryByWeek[w] = {}; });
        gloryRows.forEach(function (r) {
            if (!gloryByWeek[r.week_start]) gloryByWeek[r.week_start] = {};
            gloryByWeek[r.week_start][normalizePseudo(r.pseudo)] = r.score || 0;
        });

        var weekStarts = Object.keys(gloryByWeek).sort();
        var gloryDeltas = {};
        membersList.forEach(function (pseudo) {
            var norm = normalizePseudo(pseudo);
            var playerWeeks = weekStarts.filter(function (w) {
                var sc = gloryByWeek[w][norm] || 0;
                return sc > 0;
            });

            var totalDelta = 0;
            for (var j = 1; j < playerWeeks.length - 1; j++) {
                var prev = gloryByWeek[playerWeeks[j]][norm] || 0;
                var curr = gloryByWeek[playerWeeks[j + 1]][norm] || 0;
                var diff = curr - prev;
                if (diff > 0) totalDelta += diff;
            }
            gloryDeltas[pseudo] = totalDelta;
        });
        var maxGloryDelta = Math.max.apply(null, Object.values(gloryDeltas).concat([0]));

        var aggMap = {};
        membersList.forEach(function (pseudo) {
            aggMap[pseudo] = { eventsScore: 0, eventsAttended: 0, eventsTotal: 0 };
        });

        var validPartRows = partRows.filter(function (p) { return !p.is_pending; });

        var tenantEventInstances = new Set();
        validPartRows.forEach(function (p) {
            if ((p.event_name || '').toLowerCase() === 'glory') return;
            var evKey = (window.GM && window.GM.eventScoringKey) ? window.GM.eventScoringKey(p.event_name, p.session_id, p.week_start) : (p.event_name + '|' + (p.session_id || p.week_start));
            if (evKey) tenantEventInstances.add(evKey);
        });
        var totalTenantEvents = tenantEventInstances.size;

        var attendedSessionsByMember = {};
        membersList.forEach(function (pseudo) {
            attendedSessionsByMember[normalizePseudo(pseudo)] = new Set();
        });

        validPartRows.forEach(function (p) {
            if ((p.event_name || '').toLowerCase() === 'glory') return;
            var norm = normalizePseudo(p.pseudo);
            var memberMatch = membersList.find(function (m) { return normalizePseudo(m) === norm; });
            if (!memberMatch) return;

            var agg = aggMap[memberMatch];
            var evName = (p.event_name || '').trim();
            var coeff = COEFFS[evName] || 1;
            var evKey = (window.GM && window.GM.eventScoringKey) ? window.GM.eventScoringKey(evName, p.session_id, p.week_start) : (evName + '|' + (p.session_id || p.week_start));

            var attended = (p.participated > 0) || (p.sub_present === true) || (p.score > 0) || (p.score_prep > 0) || (p.score_pvp > 0);

            if (attended && !attendedSessionsByMember[norm].has(evKey)) {
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
        });

        membersList.forEach(function (pseudo) {
            if (aggMap[pseudo]) aggMap[pseudo].eventsTotal = totalTenantEvents;
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

    async function loadSingleEventMode(eventName) {
        var db = getDb();
        try {
            var dataRes = await db.rpc('gm_stats_data', { p_guild: state.activeGuild });
            var raw = dataRes.data || null;
            var allParts = (raw && raw.participants) || [];
            var rows = allParts.filter(function (r) { return r.event_name === eventName; });
            rows = keepOnlyPastOrCurrent(rows);

            if (state.statsPeriod !== 'all' && state.selectedWeek) {
                rows = rows.filter(function (r) { return r.week_start === state.selectedWeek; });
            }

            var byMember = {};
            rows.forEach(function (r) {
                var norm = normalizePseudo(r.pseudo);
                if (!byMember[norm]) {
                    byMember[norm] = {
                        pseudo: r.pseudo,
                        score: 0,
                        score_prep: 0,
                        score_pvp: 0,
                        events_done: 0,
                        events_total: 0
                    };
                }
                var prep = r.score_prep || 0;
                var pvp = r.score_pvp || 0;
                var sc = r.score || 0;
                var tot = sc > 0 ? sc : (prep + pvp);
                byMember[norm].score_prep += prep;
                byMember[norm].score_pvp += pvp;
                byMember[norm].score += tot;
                if (r.participated > 0 || prep > 0 || pvp > 0 || sc > 0) {
                    byMember[norm].events_done += 1;
                }
                byMember[norm].events_total += 1;
            });

            state.leaderboardData = Object.values(byMember).map(function (m) {
                return {
                    pseudo: m.pseudo,
                    score: m.score,
                    score_prep: m.score_prep,
                    score_pvp: m.score_pvp,
                    events_done: m.events_done,
                    events_total: m.events_total,
                    attendance_rate: m.events_total > 0 ? m.events_done / m.events_total : 0,
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

    async function loadParticipationMode() {
        var db = getDb();
        try {
            var memRes = await db.from('guild_members').select('pseudo').eq('guild', state.activeGuild);
            var dataRes = await db.rpc('gm_stats_data', { p_guild: state.activeGuild });
            var raw = dataRes.data || null;
            var partRes = { data: (raw && raw.participants) || [] };

            var memberSet = new Set();
            (memRes.data || []).forEach(function (m) { if (m.pseudo) memberSet.add(m.pseudo); });
            (partRes.data || []).forEach(function (r) { if (r.pseudo) memberSet.add(r.pseudo); });

            var membersList = Array.from(memberSet).sort(function (a, b) { return a.localeCompare(b); });
            var validRows = (partRes.data || []).filter(function (r) { return !r.is_pending; });
            validRows = keepOnlyPastOrCurrent(validRows);

            var tenantEventInstances = new Set();
            validRows.forEach(function (r) {
                if ((r.event_name || '').toLowerCase() === 'glory') return;
                var evKey = (window.GM && window.GM.eventScoringKey) ? window.GM.eventScoringKey(r.event_name, r.session_id, r.week_start) : (r.event_name + '|' + (r.session_id || r.week_start));
                if (evKey) tenantEventInstances.add(evKey);
            });
            var totalTenantEvents = tenantEventInstances.size;

            var attendedSessionsByMember = {};
            membersList.forEach(function (m) {
                attendedSessionsByMember[normalizePseudo(m)] = new Set();
            });

            validRows.forEach(function (r) {
                if ((r.event_name || '').toLowerCase() === 'glory') return;
                var norm = normalizePseudo(r.pseudo);
                if (attendedSessionsByMember[norm]) {
                    var evKey = (window.GM && window.GM.eventScoringKey) ? window.GM.eventScoringKey(r.event_name, r.session_id, r.week_start) : (r.event_name + '|' + (r.session_id || r.week_start));
                    if (r.participated > 0 || r.sub_present === true) {
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

    function renderLeaderboard() {
        var containers = document.querySelectorAll('.stats-leaderboard-area');
        if (!containers || !containers.length) return;

        var tabsHtml = getTabsHtml(state.currentMode);

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

            // Top 3 Podium Stage
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

            var isBattleEventMode = (state.currentMode === 'SvS' || state.currentMode === 'GvG');
            var showGloryCol = (state.currentMode === 'global');

            var tableHtml =
                '<div class="gm-card glass-card" style="padding:1.25rem;">' +
                    '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                        '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                            '<thead><tr>' +
                                '<th class="gm-center" style="width:65px;">#</th>' +
                                '<th>' + (t('col_member') || 'Member') + '</th>' +
                                '<th class="gm-center">' + (t('stats_events') || 'Events') + '</th>' +
                                (isBattleEventMode ?
                                    '<th class="gm-center">' + (t('col_score_prep') || 'Day 1 to 5 score') + '</th>' +
                                    '<th class="gm-center">' + (t('col_score_pvp') || 'Day 6 score') + '</th>' : ''
                                ) +
                                (showGloryCol ? '<th class="gm-center">' + (t('stats_glory_delta') || 'Glory Δ') + '</th>' : '') +
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
                        (isBattleEventMode ?
                            '<td class="gm-center" style="font-family:var(--font-display); font-weight:600; color:var(--fg-dim); font-variant-numeric:tabular-nums;">' + fmt(m.score_prep || 0) + '</td>' +
                            '<td class="gm-center" style="font-family:var(--font-display); font-weight:600; color:var(--fg-dim); font-variant-numeric:tabular-nums;">' + fmt(m.score_pvp || 0) + '</td>' : ''
                        ) +
                        (showGloryCol ? '<td class="gm-center" style="color:var(--fg-dim); font-variant-numeric:tabular-nums;">' + (m.glory_delta > 0 ? '+' + fmt(m.glory_delta) : '-') + '</td>' : '') +
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

    // ── 2. KPI: GUILD HEALTH (Power macro view) ──────────────────────────────────
    async function renderKpiHealth(container, db, g, tabsHtml) {
        var membersRes = await db.from('guild_members').select('pseudo, overall_power, role, created_at').eq('guild', g);
        var members = membersRes.data || [];
        var totalPower = members.reduce(function (a, m) { return a + (parseInt(m.overall_power, 10) || 0); }, 0);
        var active = members.filter(function (m) { return (parseInt(m.overall_power, 10) || 0) > 0; });
        var avgPower = active.length > 0 ? Math.round(totalPower / active.length) : 0;

        var maxPower = members.reduce(function (a, m) { return Math.max(a, parseInt(m.overall_power, 10) || 0); }, 0);
        var tiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };
        members.forEach(function (m) {
            var tier = (window.GM && window.GM.getPowerTier) ? window.GM.getPowerTier(m.overall_power, maxPower) : 'C';
            if (tiers[tier] !== undefined) tiers[tier]++;
        });

        var sorted = active.slice().sort(function (a, b) { return (parseInt(b.overall_power, 10) || 0) - (parseInt(a.overall_power, 10) || 0); });
        var pct = function (n) {
            if (totalPower <= 0) return 0;
            return Math.round(sorted.slice(0, n).reduce(function (a, m) { return a + (parseInt(m.overall_power, 10) || 0); }, 0) / totalPower * 100);
        };
        var top5 = pct(5), top10 = pct(10);

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

    // ── 3. KPI: ENGAGEMENT & INACTIVE MEMBERS ──────────────────────────────────
    async function renderKpiEngagement(container, db, g, tabsHtml) {
        var dataRes = await db.rpc('gm_stats_data', { p_guild: g });
        var raw = dataRes.data || null;
        var partsRes = { data: (raw && raw.participants) || [] };
        var rows = (partsRes.data || []).filter(function (r) { return !r.is_pending; });
        rows = keepOnlyPastOrCurrent(rows);

        var membersRes = await db.from('guild_members').select('pseudo, overall_power').eq('guild', g);
        var members = membersRes.data || [];

        var weekSet = {};
        rows.forEach(function (r) { if (r.week_start) weekSet[r.week_start] = true; });
        var allWeeks = Object.keys(weekSet).sort(function (a, b) { return b.localeCompare(a); });
        var lastWeeks = allWeeks.slice(0, 8).reverse();

        var perWeek = {};
        lastWeeks.forEach(function (w) {
            var present = {};
            var presentCount = 0;
            rows.forEach(function (r) {
                if (r.week_start !== w) return;
                var attended = (r.participated > 0) || (r.sub_present === true);
                if (!attended) return;
                var key = (window.GM && window.GM.eventScoringKey) ? window.GM.eventScoringKey(r.event_name, r.session_id, r.week_start) : (r.event_name + '|' + (r.session_id || r.week_start));
                if (!key) return;
                var norm = normalizePseudo(r.pseudo);
                if (!present[norm]) { present[norm] = {}; presentCount++; }
                present[norm][key] = true;
            });
            perWeek[w] = {
                present: presentCount,
                memberCount: members.length,
                rate: members.length > 0 ? Math.round(presentCount / members.length * 100) : 0
            };
        });

        var typeCounts = { 'SvS': 0, 'GvG': 0, 'Shadowfront': 0, 'Arms Race': 0, 'DTR': 0 };
        var typeNames = { 'SvS': 'SvS', 'GvG': 'GvG', 'Shadowfront': 'Shadowfront', 'Arms Race': 'Arms Race', 'DTR': 'DTR' };
        var typeMembers = {};
        Object.keys(typeCounts).forEach(function (k) { typeMembers[k] = {}; });
        rows.forEach(function (r) {
            if (lastWeeks.indexOf(r.week_start) === -1) return;
            var attended = (r.participated > 0) || (r.sub_present === true);
            if (!attended) return;
            var key = (window.GM && window.GM.eventScoringKey) ? window.GM.eventScoringKey(r.event_name, r.session_id, r.week_start) : (r.event_name + '|' + (r.session_id || r.week_start));
            var prefix = key.split('|')[0];
            var t = null;
            if (prefix === 'SvS') t = 'SvS';
            else if (prefix === 'GvG') t = 'GvG';
            else if (prefix === 'Shadowfront') t = 'Shadowfront';
            else if (prefix === 'Arms Race') t = 'Arms Race';
            else if (prefix === 'DTR') t = 'DTR';
            if (!t) return;
            typeMembers[t][normalizePseudo(r.pseudo)] = true;
        });
        Object.keys(typeCounts).forEach(function (k) {
            typeCounts[k] = Object.keys(typeMembers[k]).length;
        });

        var activeWindow = lastWeeks.length > 0 ? lastWeeks.slice(-2) : [];
        var activeMembers = {};
        rows.forEach(function (r) {
            if (activeWindow.indexOf(r.week_start) === -1) return;
            var attended = (r.participated > 0) || (r.sub_present === true);
            if (!attended) return;
            activeMembers[normalizePseudo(r.pseudo)] = true;
        });
        var inactive = members.filter(function (m) {
            return !activeMembers[normalizePseudo(m.pseudo)];
        });

        var lastSeen = {};
        rows.forEach(function (r) {
            if ((r.participated > 0) || (r.sub_present === true)) {
                var n = normalizePseudo(r.pseudo);
                if (!lastSeen[n] || r.week_start > lastSeen[n]) lastSeen[n] = r.week_start;
            }
        });
        inactive = inactive.map(function (m) {
            return { pseudo: m.pseudo, power: parseInt(m.overall_power, 10) || 0, lastSeen: lastSeen[normalizePseudo(m.pseudo)] || null };
        }).sort(function (a, b) {
            var la = a.lastSeen ? a.lastSeen : '';
            var lb = b.lastSeen ? b.lastSeen : '';
            if (la !== lb) return la < lb ? -1 : 1;
            return b.power - a.power;
        });

        var weekBars = lastWeeks.map(function (w) {
            var d = perWeek[w];
            var weekNum = getWeekNumber(w);
            var weekLabel = (weekNum ? 'Week ' + weekNum : shortDate(w));
            var pctRate = d.rate;
            var barColor = pctRate >= 70 ? '#34d399' : (pctRate >= 40 ? '#a78bfa' : '#f87171');
            return '<div class="gm-kpi-row" style="display:flex; align-items:center; gap:0.75rem; margin-bottom:0.75rem;">' +
                '<span class="gm-kpi-label" style="min-width:90px; font-weight:600; font-size:0.83rem; color:var(--fg);">' + esc(weekLabel) + '</span>' +
                '<div class="gm-kpi-bar-track" style="flex:1; height:22px; background:var(--bg-3); border-radius:6px; overflow:hidden; position:relative;">' +
                    '<div class="gm-kpi-bar" style="width:' + pctRate + '%; height:100%; background:' + barColor + '; border-radius:6px; transition:width .4s ease;"></div>' +
                '</div>' +
                '<span class="gm-kpi-value" style="min-width:120px; text-align:right; font-weight:700; font-size:0.85rem; font-family:var(--font-display); color:var(--fg);">' +
                    pctRate + '% <span style="font-size:0.75rem; font-weight:500; color:var(--fg-dim);">(' + d.present + '/' + d.memberCount + ')</span>' +
                '</span>' +
            '</div>';
        }).join('');

        var typeOrder = ['GvG', 'SvS', 'Shadowfront', 'Arms Race', 'DTR'];
        var typeColors = { 'GvG': '#60a5fa', 'SvS': '#fbbf24', 'Shadowfront': '#c084fc', 'Arms Race': '#f87171', 'DTR': '#34d399' };
        var maxType = 0;
        typeOrder.forEach(function (k) { if (typeCounts[k] > maxType) maxType = typeCounts[k]; });
        var typeBars = typeOrder.map(function (k) {
            var pctW = maxType > 0 ? Math.round(typeCounts[k] / maxType * 100) : 0;
            return '<div class="gm-kpi-row"><span class="gm-kpi-label">' + typeNames[k] + '</span>' +
                '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pctW + '%; background:' + (typeColors[k] || '#a78bfa') + ';"></div></div>' +
                '<span class="gm-kpi-value">' + typeCounts[k] + ' members</span></div>';
        }).join('');

        var sumRate = 0;
        lastWeeks.forEach(function (w) { sumRate += perWeek[w].rate; });
        var avgRate = lastWeeks.length > 0 ? Math.round(sumRate / lastWeeks.length) : 0;

        var inactiveHtml = inactive.length === 0
            ? '<div class="gm-empty" style="padding:2.5rem 1.5rem; text-align:center;">' +
                '<i class="ph-duotone ph-check-circle gm-icon" style="font-size:2.4rem; color:var(--accent-mint); margin-bottom:.5rem; display:block;"></i>' +
                '<div class="gm-empty-title" style="font-size:1.1rem; font-weight:700; color:var(--fg);">Every member participated in the last 2 weeks</div>' +
                '<div style="font-size:0.85rem; color:var(--fg-dim); margin-top:0.25rem;">No inactive members detected on the roster.</div>' +
              '</div>'
            : '<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:0.85rem; margin-top:0.5rem;">' +
                inactive.slice(0, 20).map(function (m) {
                    var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(m.pseudo) : (m.pseudo ? m.pseudo.charAt(0).toUpperCase() : '?');
                    var seenText = m.lastSeen ? 'Seen ' + shortDate(m.lastSeen) : 'Never participated';
                    var pwr = formatBigNum(m.power);

                    return '<div style="background:var(--bg-2); border:1px solid var(--border-soft); border-radius:var(--radius-md); padding:0.9rem 1.1rem; display:flex; align-items:center; justify-content:space-between; gap:1rem;">' +
                        '<div style="display:flex; align-items:center; gap:0.85rem; min-width:0; flex:1;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:40px; height:40px; font-size:.95rem; font-weight:700; background:oklch(0.25 0.08 20); color:#f87171; flex-shrink:0;">' + esc(initial) + '</div>' +
                            '<div style="min-width:0; flex:1;">' +
                                '<div style="font-weight:700; color:var(--fg); font-size:0.95rem; word-break:break-word;">' + esc(m.pseudo) + '</div>' +
                                '<div style="font-size:0.78rem; color:var(--fg-dim); display:flex; align-items:center; gap:0.35rem; margin-top:3px;">' +
                                    '<i class="ph ph-lightning" style="color:var(--accent-amber);"></i> ' + esc(pwr) +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div style="flex-shrink:0;">' +
                            '<span style="font-size:0.75rem; font-weight:600; padding:4px 10px; border-radius:99px; background:oklch(0.25 0.08 20); color:#f87171; border:1px solid oklch(0.45 0.15 20 / 0.4); display:inline-flex; align-items:center; gap:0.35rem; white-space:nowrap;">' +
                                '<i class="ph ph-warning-circle"></i> ' + esc(seenText) +
                            '</span>' +
                        '</div>' +
                    '</div>';
                }).join('') +
              '</div>' +
              (inactive.length > 20 ? '<div style="margin-top:0.75rem; text-align:center; font-size:0.8rem; color:var(--fg-dim); font-weight:600;">+ ' + (inactive.length - 20) + ' more inactive members</div>' : '');

        var html = tabsHtml +
            '<div class="gm-kpi-grid">' +
                kpiTile('Active this week', perWeek[lastWeeks[lastWeeks.length - 1]] ? perWeek[lastWeeks[lastWeeks.length - 1]].present : 0, 'ph-user-check', 'stat-theme-lime') +
                kpiTile('Avg participation (8w)', avgRate + '%', 'ph-chart-line-up', avgRate >= 50 ? 'stat-theme-mint' : 'stat-theme-coral') +
                kpiTile('Inactive (2w+)', inactive.length, 'ph-user-minus', inactive.length > 5 ? 'stat-theme-coral' : 'stat-theme-mint') +
                kpiTile('Weeks with data', lastWeeks.length, 'ph-calendar', 'stat-theme-cyan') +
            '</div>' +
            '<div class="gm-kpi-grid" style="margin-top:0.85rem;">' +
                '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-chart-line-up"></i> Weekly participation rate</div>' +
                    '<div class="gm-kpi-card-body">' + weekBars + '</div></div>' +
                '<div class="gm-kpi-card"><div class="gm-kpi-card-title"><i class="ph ph-chart-pie"></i> Members engaged per event type (8w)</div>' +
                    '<div class="gm-kpi-card-body">' + typeBars + '</div></div>' +
            '</div>' +
            '<div class="gm-kpi-card" style="margin-top:0.85rem;"><div class="gm-kpi-card-title"><i class="ph ph-user-minus"></i> Members inactive for 2+ weeks</div>' +
                '<div class="gm-kpi-card-body">' + inactiveHtml + '</div>' +
            '</div>';

        container.innerHTML = html;
        wireModeTabs(container);
    }

    // ── 4. KPI: ROSTER & OPERATIONS ───────────────────────────────────────────
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

        var html = tabsHtml +
            '<div class="gm-kpi-grid">' +
                kpiTile('Members', members.length, 'ph-users', 'stat-theme-cyan') +
                kpiTile('Officers (R4/R5)', (roles.R5 + roles.R4), 'ph-shield-star', 'stat-theme-lime') +
                kpiTile('Vanguard (R3)', roles.R3, 'ph-shield', 'stat-theme-mint') +
                kpiTile('Regulars (R1/R2)', (roles.R2 + roles.R1), 'ph-user', 'stat-theme-lilac') +
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

    async function renderKpiOperations(container, db, g, tabsHtml) {
        var pendingRes = await db.from('event_participants')
            .select('pseudo, event_name, week_start')
            .eq('guild', g)
            .eq('is_pending', true);
        var pending = pendingRes.data || [];

        var membersRes = await db.from('guild_members').select('id').eq('guild', g);
        var memberCount = (membersRes.data || []).length;
        var statusRes = await db.from('event_status').select('event_name, session_id').eq('guild', g).eq('is_active', true);
        var activeEvents = statusRes.data || [];
        var importedRes = await db.from('event_participants')
            .select('session_id', { count: 'exact', head: true })
            .eq('guild', g)
            .in('session_id', activeEvents.map(function (s) { return s.session_id; }).filter(Boolean));
        var importedCount = importedRes.count || 0;
        var completeness = activeEvents.length > 0 && memberCount > 0 ? Math.min(100, Math.round(importedCount / (activeEvents.length * memberCount) * 100)) : 0;

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

    // ── KPI Helpers ───────────────────────────────────────────────────────────
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

    async function renderKpiTab() {
        var containers = document.querySelectorAll('.stats-leaderboard-area');
        if (!containers || !containers.length) return;
        var container = containers[0];
        var mode = state.currentMode;

        var tabsHtml = getTabsHtml(mode);
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

})();
