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
        'Shadowfront': { coeff: 3, hasScore: false, dbNames: ['Shadowfront', 'Shadowfront Squad 1', 'Shadowfront Squad 2'] },
        'DTR':         { coeff: 2, hasScore: false, dbNames: ['Defend Trade Route', 'DTR'] },
        'Arms Race':   { coeff: 1, hasScore: false, dbNames: ['ARMS RACE STAGE A', 'ARMS RACE STAGE B', 'ARMS RACE', 'Arms Race'] }
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

    // ── Helper: Normalisation & Dédoublonnage ──────────────────────────────────
    function normalizePseudo(p) {
        return p ? p.trim().toLowerCase() : '';
    }

    function deduplicateParticipants(rows) {
        var map = {};
        rows.forEach(function(p) {
            var norm = normalizePseudo(p.pseudo);
            var key = norm + '|' + p.event_name + '|' + (p.session_id || p.week_start);
            if (!map[key]) {
                map[key] = Object.assign({}, p);
                map[key].pseudoNorm = norm;
            } else {
                var existing = map[key];
                if ((p.participated || 0) > (existing.participated || 0)) existing.participated = p.participated;
                if ((p.score || 0) > (existing.score || 0)) existing.score = p.score;
                if ((p.score_prep || 0) > (existing.score_prep || 0)) existing.score_prep = p.score_prep;
                if ((p.score_pvp || 0) > (existing.score_pvp || 0)) existing.score_pvp = p.score_pvp;
            }
        });
        return Object.values(map);
    }

    // ── State ──────────────────────────────────────────────────────────────────
    var currentWeek     = window.RAD ? window.RAD.getWeekStart() : '';
    var statsPeriod     = '1w';
    var allWeeks        = [];
    var leaderboardData = [];
    var lastMaxPossible = 0;
    var uidByPseudo     = {};
    var currentMode     = 'global'; // 'global' | 'SvS' | 'GvG' | 'prince' | 'participation'
    var participationPeriod = '8w'; // '4w' | '8w' | 'all'

    // Liste des onglets — recalculée à chaque render pour respecter la langue.
    function statsModes() {
        return [
            { key: 'global',        label: t('stats_tab_global'),        icon: 'ph-globe' },
            { key: 'SvS',           label: t('stats_tab_svs'),           icon: 'ph-sword' },
            { key: 'GvG',           label: t('stats_tab_gvg'),           icon: 'ph-flag-banner' },
            { key: 'prince',        label: t('stats_tab_prince'),        icon: 'ph-crown' },
            { key: 'participation', label: t('stats_tab_participation'), icon: 'ph-chart-bar' }
        ];
    }

    // ── Public API ──────────────────────────────────────────────────────────────
    window.RAD_STATS = { load: loadStats };

    async function loadStats() {
        if (!db) return;
        await fetchAllWeeks();
        renderControls();
        await refreshData();
    }

    async function refreshData() {
        if (currentMode === 'participation') {
            await loadParticipation();
            return;
        }
        if (currentMode === 'global') {
            var idx = allWeeks.indexOf(currentWeek);
            if (idx === -1) idx = 0;
            var weeksToLoad = [currentWeek];
            if (statsPeriod === '4w') {
                weeksToLoad = allWeeks.slice(idx, idx + 4);
            } else if (statsPeriod === '8w') {
                weeksToLoad = allWeeks.slice(idx, idx + 8);
            }
            await loadGlobalPeriod(weeksToLoad);
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

        var [membersRes, partsRes, gloryRes, squadsRes, coeffSvs, coeffGvg, coeffShadowfront, coeffDtr, coeffArmsrace] = await Promise.all([
            db.from('guild_members').select('pseudo, uid'),
            db.from('event_participants').select('*').in('week_start', weeks).neq('event_name', 'Glory').limit(100000),
            db.from('event_participants').select('pseudo, score, week_start').eq('event_name', 'Glory').in('week_start', glorySpan).limit(100000),
            db.from('shadowfront_squads').select('pseudo, role, week_start').in('week_start', weeks).limit(100000),
            window.RAD.config.get('coeff_svs'),
            window.RAD.config.get('coeff_gvg'),
            window.RAD.config.get('coeff_shadowfront'),
            window.RAD.config.get('coeff_dtr'),
            window.RAD.config.get('coeff_armsrace')
        ]);

        var memberRows   = membersRes.data || [];
        var members      = memberRows.map(function (m) { return m.pseudo; });
        uidByPseudo = {};
        memberRows.forEach(function (m) { uidByPseudo[m.pseudo] = m.uid || ''; });
        var participants = deduplicateParticipants(partsRes.data || []);
        var gloryByWeek  = buildGloryByWeek(gloryRes.data || [], glorySpan);

        var config = {
            coeff_svs: parseInt(coeffSvs, 10) || 5,
            coeff_gvg: parseInt(coeffGvg, 10) || 5,
            coeff_shadowfront: parseInt(coeffShadowfront, 10) || 3,
            coeff_dtr: parseInt(coeffDtr, 10) || 2,
            coeff_armsrace: parseInt(coeffArmsrace, 10) || 1
        };

        if (members.length === 0) { renderEmpty(); return; }

        var result = computeScores(members, participants, gloryByWeek, weeks, config, squadsRes.data || []);
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
            .select('pseudo, score, score_prep, score_pvp, participated')
            .eq('event_name', eventName)
            .eq('week_start', week);

        var agg = {};
        (res.data || []).forEach(function (r) {
            if (!agg[r.pseudo]) agg[r.pseudo] = { pseudo: r.pseudo, score: 0, participated: 0 };
            // SvS : on additionne prep + pvp pour les nouvelles saisies, score pour les legacy
            agg[r.pseudo].score        += (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0);
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

    // ── Participation : taux par événement + joueurs actifs / inactifs ─────────
    // Période sélectionnable (4 / 8 dernières semaines ou tout l'historique).
    // Un "slot" = une ligne event_participants : pour chaque slot d'un joueur on
    // sait s'il a participé (participated > 0). Le taux par événement est la
    // moyenne pondérée par slot — pas par session — pour rester comparable
    // quand le nombre de membres varie entre semaines.
    async function loadParticipation() {
        var weeksFilter = null;
        if (participationPeriod === '4w')      weeksFilter = allWeeks.slice(0, 4);
        else if (participationPeriod === '8w') weeksFilter = allWeeks.slice(0, 8);

        var membersRes = await db.from('guild_members').select('pseudo');
        var members = (membersRes.data || []).map(function (m) { return m.pseudo; });

        var query = db.from('event_participants')
            .select('pseudo, event_name, week_start, participated')
            .neq('event_name', 'Glory')
            .limit(100000);
        if (weeksFilter) query = query.in('week_start', weeksFilter);
        var partsRes = await query;
        var participants = deduplicateParticipants(partsRes.data || []);

        var data = computeParticipation(members, participants);
        data.period = participationPeriod;
        data.weeksUsed = weeksFilter ? weeksFilter.length : allWeeks.length;
        renderParticipationView(data);
    }

    function computeParticipation(members, participants) {
        var eventToGroup = {};
        Object.keys(EVENT_GROUPS).forEach(function (g) {
            EVENT_GROUPS[g].dbNames.forEach(function (n) { eventToGroup[n.toLowerCase()] = g; });
        });

        var byEvent = {};
        Object.keys(EVENT_GROUPS).forEach(function (g) {
            byEvent[g] = {
                name: g,
                coeff: EVENT_GROUPS[g].coeff,
                rows: 0,
                attendances: 0,
                sessions: {}, // unique weeks it ran
                uniqueParticipants: {}
            };
        });

        var byPlayer = {};
        members.forEach(function (p) {
            byPlayer[normalizePseudo(p)] = { pseudo: p, attended: 0, possible: 0 };
        });

        // Group rows by opportunity (session_id + groupName)
        var oppMap = {};
        participants.forEach(function (p) {
            var originalName = (p.event_name || '').trim();
            var evName = originalName.toLowerCase();
            if (!evName || evName === 'glory') return;

            var group = eventToGroup[evName];
            if (!group) {
                group = originalName;
                eventToGroup[evName] = group;
                if (!byEvent[group]) {
                    byEvent[group] = {
                        name: group,
                        coeff: 1,
                        rows: 0,
                        attendances: 0,
                        sessions: {},
                        uniqueParticipants: {}
                    };
                }
            }
            
            var oppKey = p.session_id || p.week_start;
            var key = oppKey + '|' + group;
            if (!oppMap[key]) {
                oppMap[key] = { group: group, oppKey: oppKey, players: {} };
            }
            var norm = normalizePseudo(p.pseudo);
            if (!oppMap[key].players[norm]) {
                oppMap[key].players[norm] = { participated: false };
            }
            if (p.participated > 0) {
                oppMap[key].players[norm].participated = true;
            }
        });

        // Aggregate stats
        Object.keys(oppMap).forEach(function (key) {
            var wg = oppMap[key];
            var ev = byEvent[wg.group];
            ev.sessions[wg.oppKey] = true;
            
            Object.keys(wg.players).forEach(function (norm) {
                var pData = wg.players[norm];
                ev.rows++;
                if (pData.participated) {
                    ev.attendances++;
                    ev.uniqueParticipants[norm] = true;
                }
                if (byPlayer[norm]) {
                    byPlayer[norm].possible++;
                    if (pData.participated) {
                        byPlayer[norm].attended++;
                    }
                }
            });
        });

        var eventSummary = Object.keys(byEvent).map(function (g) {
            var e = byEvent[g];
            return {
                name: g,
                coeff: e.coeff,
                sessions: Object.keys(e.sessions).length,
                rate: e.rows > 0 ? e.attendances / e.rows : 0,
                attendances: e.attendances,
                rows: e.rows,
                uniqueParticipants: Object.keys(e.uniqueParticipants).length
            };
        }).filter(function (e) { return e.sessions > 0; })
          .sort(function (a, b) { return b.rate - a.rate; });

        var playerList = Object.keys(byPlayer).map(function (k) {
            var p = byPlayer[k];
            p.rate = p.possible > 0 ? p.attended / p.possible : 0;
            return p;
        }).filter(function (p) { return p.possible > 0; });

        // Égalité de taux : on départage par "opportunités" — plus la fenêtre
        // ouverte est large, plus l'écart de comportement est significatif.
        var sortedActive = playerList.slice().sort(function (a, b) {
            if (b.rate !== a.rate) return b.rate - a.rate;
            if (b.possible !== a.possible) return b.possible - a.possible;
            return a.pseudo.localeCompare(b.pseudo);
        });
        var sortedInactive = playerList.slice().sort(function (a, b) {
            if (a.rate !== b.rate) return a.rate - b.rate;
            if (b.possible !== a.possible) return b.possible - a.possible;
            return a.pseudo.localeCompare(b.pseudo);
        });

        return {
            totalMembers: members.length,
            eventSummary: eventSummary,
            topActive: sortedActive.slice(0, 10),
            topInactive: sortedInactive.slice(0, 10)
        };
    }

    function renderParticipationView(data) {
        var modes = statsModes();

        document.querySelectorAll('.stats-leaderboard-area').forEach(function (container) {
            var tabsHtml = '<div class="gm-tabs-pill" style="margin-bottom:1rem;">' +
                modes.map(function (m) {
                    return '<button class="gm-tab-pill' + (currentMode === m.key ? ' gm-active' : '') + '" data-gm-mode="' + m.key + '">' +
                        '<i class="ph ' + m.icon + '"></i> ' + m.label + '</button>';
                }).join('') +
            '</div>';

            var periods = [
                { key: '4w',  label: t('stats_part_period_4w') },
                { key: '8w',  label: t('stats_part_period_8w') },
                { key: 'all', label: t('stats_part_period_all') }
            ];
            var periodHtml =
                '<div class="gm-part-period">' +
                    '<span class="gm-dim" style="margin-right:.25rem;">' + t('stats_part_period_label') + '</span>' +
                    periods.map(function (p) {
                        return '<button class="gm-chip part-period' + (participationPeriod === p.key ? ' gm-chip-accent active' : '') + '" data-period="' + p.key + '">' +
                            esc(p.label) + '</button>';
                    }).join('') +
                    '<span class="gm-dim" style="margin-left:auto;">' +
                        data.weeksUsed + ' ' + t('stats_part_weeks') + ' · ' +
                        data.totalMembers + ' ' + t('stats_part_members') +
                    '</span>' +
                '</div>';

            if (!data.eventSummary.length) {
                container.innerHTML = tabsHtml + periodHtml +
                    '<div class="gm-empty"><i class="ph-duotone ph-chart-bar gm-icon"></i><div class="gm-empty-title">' + t('stats_part_no_data') + '</div></div>';
                wireStatsTabs(container);
                wirePartPeriod(container);
                return;
            }

            var eventsHtml = '<div class="gm-section">' +
                '<div class="gm-section-title"><i class="ph ph-chart-bar"></i>' +
                    '<span>' + t('stats_part_by_event') + '</span></div>' +
                '<div class="gm-part-event-grid">';
            data.eventSummary.forEach(function (e) {
                var rate = Math.round(e.rate * 100);
                eventsHtml +=
                    '<div class="gm-part-event-card">' +
                        '<div class="gm-part-event-head">' +
                            '<strong>' + esc(e.name) + '</strong>' +
                            '<span class="gm-chip">×' + e.coeff + '</span>' +
                        '</div>' +
                        '<div class="gm-part-event-rate">' + rate + '<span class="gm-part-pct">%</span></div>' +
                        '<div class="gm-part-bar"><div class="gm-part-bar-fill" style="width:' + rate + '%;"></div></div>' +
                        '<div class="gm-part-event-meta">' +
                            '<span><i class="ph ph-calendar"></i> ' + e.sessions + ' ' + t('stats_part_sessions') + '</span>' +
                            '<span><i class="ph ph-users"></i> ' + e.uniqueParticipants + ' ' + t('stats_part_players') + '</span>' +
                        '</div>' +
                    '</div>';
            });
            eventsHtml += '</div></div>';

            var playersHtml = '<div class="gm-part-players-grid">' +
                renderPartPlayerCard({
                    title: t('stats_part_most_active'),
                    sub:   t('stats_part_most_active_sub'),
                    icon:  'ph-fire',
                    variant: 'success',
                    players: data.topActive
                }) +
                renderPartPlayerCard({
                    title: t('stats_part_least_active'),
                    sub:   t('stats_part_least_active_sub'),
                    icon:  'ph-ghost',
                    variant: 'danger',
                    players: data.topInactive
                }) +
            '</div>';

            container.innerHTML = tabsHtml + periodHtml + eventsHtml + playersHtml;

            wireStatsTabs(container);
            wirePartPeriod(container);
            container.querySelectorAll('.gm-part-player-row[data-pseudo]').forEach(function (row) {
                row.addEventListener('click', function () {
                    openProfile(row.getAttribute('data-pseudo'));
                });
            });
        });
    }

    function renderPartPlayerCard(opts) {
        var html = '<div class="gm-part-players-card gm-part-players-' + opts.variant + '">' +
            '<div class="gm-part-players-head">' +
                '<i class="ph-fill ' + opts.icon + '"></i>' +
                '<div>' +
                    '<div class="gm-part-players-title">' + opts.title + '</div>' +
                    '<div class="gm-part-players-sub">' + opts.sub + '</div>' +
                '</div>' +
            '</div>';

        if (!opts.players.length) {
            return html + '<div class="gm-dim" style="padding:.75rem;">' + t('stats_no_data') + '</div></div>';
        }

        html += '<div class="gm-part-player-list">';
        opts.players.forEach(function (p, i) {
            var rate = Math.round(p.rate * 100);
            var initial = window.RAD.avatarInit(p.pseudo);
            html +=
                '<button class="gm-part-player-row" data-pseudo="' + esc(p.pseudo) + '">' +
                    '<span class="gm-part-player-rank">' + (i + 1) + '</span>' +
                    '<div class="gm-avatar">' + esc(initial) + '</div>' +
                    '<div class="gm-part-player-info">' +
                        '<div class="gm-part-player-name">' + esc(p.pseudo) + '</div>' +
                        '<div class="gm-part-bar gm-part-bar-thin">' +
                            '<div class="gm-part-bar-fill gm-part-bar-' + opts.variant + '" style="width:' + rate + '%;"></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="gm-part-player-stats">' +
                        '<div class="gm-part-player-rate">' + rate + '%</div>' +
                        '<div class="gm-part-player-count gm-dim">' + p.attended + '/' + p.possible + '</div>' +
                    '</div>' +
                '</button>';
        });
        html += '</div></div>';
        return html;
    }

    function wirePartPeriod(container) {
        container.querySelectorAll('.part-period').forEach(function (btn) {
            btn.addEventListener('click', function () {
                participationPeriod = btn.getAttribute('data-period');
                loadParticipation();
            });
        });
    }

    // ── Construction de la map gloire par semaine ──────────────────────────────
    function buildGloryByWeek(rows, weeks) {
        var byWeek = {};
        weeks.forEach(function (w) { byWeek[w] = {}; });
        rows.forEach(function (r) {
            if (!byWeek[r.week_start]) byWeek[r.week_start] = {};
            byWeek[r.week_start][normalizePseudo(r.pseudo)] = r.score || 0;
        });
        return byWeek;
    }

    function computeScores(members, participants, gloryByWeek, periodWeeks, config, shadowfrontSquads) {
        config = config || { coeff_svs: 5, coeff_gvg: 5, coeff_shadowfront: 3, coeff_dtr: 2, coeff_armsrace: 1, reserve_credit_pct: 50 };
        var dynamicEventGroups = {
            'SvS':         { coeff: config.coeff_svs,         hasScore: true,  dbNames: ['SvS'] },
            'GvG':         { coeff: config.coeff_gvg,         hasScore: true,  dbNames: ['GvG'] },
            'Shadowfront': { coeff: config.coeff_shadowfront, hasScore: false, dbNames: ['Shadowfront', 'Shadowfront Squad 1', 'Shadowfront Squad 2'] },
            'DTR':         { coeff: config.coeff_dtr,         hasScore: false, dbNames: ['Defend Trade Route', 'DTR'] },
            'Arms Race':   { coeff: config.coeff_armsrace,    hasScore: false, dbNames: ['ARMS RACE STAGE A', 'ARMS RACE STAGE B', 'ARMS RACE', 'Arms Race'] }
        };

        // Découverte automatique des événements non mappés (ex: nom mal orthographié, nouvel évent)
        participants.forEach(function (p) {
            var originalName = (p.event_name || '').trim();
            var evName = originalName.toLowerCase();
            if (!evName || evName === 'glory') return;
            
            var matched = false;
            Object.keys(dynamicEventGroups).forEach(function(g) {
                if (dynamicEventGroups[g].dbNames.some(function(n) { return n.toLowerCase() === evName; })) {
                    matched = true;
                }
            });
            
            if (!matched) {
                if (!dynamicEventGroups[originalName]) {
                    dynamicEventGroups[originalName] = {
                        coeff: 1,
                        hasScore: false,
                        dbNames: [originalName]
                    };
                }
            }
        });

        // Initialize aggregation per member
        var memberAgg = {};
        members.forEach(function(pseudo) {
            memberAgg[pseudo] = {
                eventsScore: 0,
                eventsAttended: 0,
                eventsTotal: 0,
                perEvent: {}
            };
        });

        var globalMaxPossible = 0;
        var globalRanEvents = {};

        // 1. Process each week independently
        periodWeeks.forEach(function(week) {
            var weekParts = participants.filter(function(p) { return p.week_start === week; });
            var weekSquads = shadowfrontSquads ? shadowfrontSquads.filter(function(s) { return s.week_start === week; }) : [];

            // Identify opportunities for this week
            var opps = [];
            Object.keys(dynamicEventGroups).forEach(function (name) {
                var group = dynamicEventGroups[name];
                var gRows = weekParts.filter(function (p) { 
                    var evName = (p.event_name || '').trim().toLowerCase();
                    return group.dbNames.some(function(n) { return n.toLowerCase() === evName; });
                });
                if (gRows.length === 0) return;

                var sessMap = {};
                gRows.forEach(function(p) {
                    var sid = p.session_id || 'no_session';
                    if (!sessMap[sid]) sessMap[sid] = [];
                    sessMap[sid].push(p);
                });
                Object.keys(sessMap).forEach(function(sid) {
                    var actualEventName = sessMap[sid][0].event_name;
                    opps.push({ 
                        id: name + '|' + week + '|' + sid, 
                        name: name, // logical group
                        actualEventName: actualEventName,
                        group: group, 
                        rows: sessMap[sid] 
                    });
                });
            });

            var maxScorePerOpp = {};
            var svsMaxesPerOpp = {};
            
            var weekMaxAdded = {};
            opps.forEach(function (opp) {
                globalRanEvents[opp.name] = opp.group;
                if (!weekMaxAdded[opp.name]) {
                    globalMaxPossible += maxEventScore(opp.group);
                    weekMaxAdded[opp.name] = true;
                }

                if (!opp.group.hasScore) { maxScorePerOpp[opp.id] = 0; return; }
                
                var perPlayer = {};
                var pPrep = {}, pPvp = {}, pLeg = {};
                
                opp.rows.forEach(function (p) {
                    var norm = normalizePseudo(p.pseudo);
                    perPlayer[norm] = (perPlayer[norm] || 0) + (p.score || 0);

                    if (opp.name === 'SvS') {
                        var isNew = (p.score_prep != null || p.score_pvp != null);
                        if (isNew) {
                            if (p.score_prep != null) pPrep[norm] = (pPrep[norm] || 0) + p.score_prep;
                            if (p.score_pvp  != null) pPvp[norm]  = (pPvp[norm]  || 0) + p.score_pvp;
                        } else if (p.score != null) {
                            pLeg[norm] = (pLeg[norm] || 0) + p.score;
                        }
                    }
                });
                var values = Object.values(perPlayer);
                maxScorePerOpp[opp.id] = values.length ? Math.max.apply(null, values) : 0;
                
                if (opp.name === 'SvS') {
                    svsMaxesPerOpp[opp.id] = {
                        prep: Math.max.apply(null, [0].concat(Object.values(pPrep))),
                        pvp: Math.max.apply(null, [0].concat(Object.values(pPvp))),
                        legacy: Math.max.apply(null, [0].concat(Object.values(pLeg)))
                    };
                }
            });

            var weekGroups = [];
            opps.forEach(function (opp) {
                if (weekGroups.indexOf(opp.name) === -1) {
                    weekGroups.push(opp.name);
                }
            });

            members.forEach(function (pseudo) {
                var normPseudo = normalizePseudo(pseudo);
                var agg = memberAgg[pseudo];
                
                // Group-based attendance tracking (fair consistency bonus)
                agg.eventsTotal += weekGroups.length;

                weekGroups.forEach(function (groupName) {
                    var groupOpps = opps.filter(function (o) { return o.name === groupName; });
                    var groupParticipated = groupOpps.some(function (opp) {
                        return opp.rows.some(function (r) {
                            return normalizePseudo(r.pseudo) === normPseudo && r.participated > 0;
                        });
                    });

                    if (groupParticipated) {
                        agg.eventsAttended++;
                    }
                });

                opps.forEach(function (opp) {
                    var pRows = opp.rows.filter(function (p) { return normalizePseudo(p.pseudo) === normPseudo; });
                    
                    var participated = pRows.some(function (r) { return r.participated > 0; });
                    var totalScore = pRows.reduce(function (s, r) { return s + (r.score || 0) + (r.score_prep || 0) + (r.score_pvp || 0); }, 0);

                    var base = 0;
                    if (participated) {
                        base = W.participation * opp.group.coeff;
                    }
                    
                    var perf = 0;
                    if (participated && opp.group.hasScore) {
                        if (opp.name === 'SvS') {
                            var plPrep = 0, plPvp = 0, plLeg = 0;
                            var nNew = 0, nLegacy = 0;
                            pRows.forEach(function (r) {
                                var isNew = (r.score_prep != null || r.score_pvp != null);
                                if (isNew) {
                                    plPrep += r.score_prep || 0;
                                    plPvp  += r.score_pvp  || 0;
                                    nNew++;
                                } else {
                                    plLeg += r.score || 0;
                                    nLegacy++;
                                }
                            });
                            var svsM = svsMaxesPerOpp[opp.id];
                            var ratioNew = 0;
                            if (nNew > 0) {
                                var rPrep = svsM.prep > 0 ? plPrep / svsM.prep : 0;
                                var rPvp  = svsM.pvp  > 0 ? plPvp  / svsM.pvp  : 0;
                                ratioNew = (rPrep + rPvp) / 2;
                            }
                            var ratioLegacy = (nLegacy > 0 && svsM.legacy > 0) ? plLeg / svsM.legacy : 0;
                            var totalN = nNew + nLegacy;
                            var ratio  = totalN > 0 ? (nNew * ratioNew + nLegacy * ratioLegacy) / totalN : 0;
                            perf = W.performance * opp.group.coeff * ratio;
                        } else if (maxScorePerOpp[opp.id] > 0) {
                            perf = W.performance * opp.group.coeff * (totalScore / maxScorePerOpp[opp.id]);
                        }
                    }
                    
                    var eventScore = base + perf;
                    agg.eventsScore += eventScore;
                    
                    var evName = opp.actualEventName;
                    if (!agg.perEvent[evName]) {
                        agg.perEvent[evName] = {
                            coeff: opp.group.coeff,
                            participated: false,
                            score: 0,
                            base: 0,
                            perf: 0,
                            total: 0,
                            max: 0
                        };
                    }
                    
                    if (participated) {
                        agg.perEvent[evName].participated = true;
                    }
                    
                    agg.perEvent[evName].score += totalScore;
                    agg.perEvent[evName].base += base;
                    agg.perEvent[evName].perf += perf;
                    agg.perEvent[evName].total += eventScore;
                    agg.perEvent[evName].max += maxEventScore(opp.group);
                });
            });
        });

        globalMaxPossible += (W.gloryMax + W.consistency) * periodWeeks.length;

        var weekStarts = Object.keys(gloryByWeek).sort();
        var deltaByPseudo = {};
        members.forEach(function (pseudo) {
            var norm = normalizePseudo(pseudo);
            var totalDelta = 0;
            for (var i = 1; i < weekStarts.length; i++) {
                var curr = gloryByWeek[weekStarts[i]][norm] || 0;
                var prev = gloryByWeek[weekStarts[i - 1]][norm] || 0;
                var d = curr - prev;
                if (d > 0) totalDelta += d;
            }
            deltaByPseudo[pseudo] = totalDelta;
        });
        var maxDelta = Math.max.apply(null, Object.values(deltaByPseudo).concat([0]));

        var scores = members.map(function (pseudo) {
            var agg = memberAgg[pseudo];
            var attendanceRate = agg.eventsTotal > 0 ? agg.eventsAttended / agg.eventsTotal : 0;
            var consistencyBonus = attendanceRate >= W.threshold ? W.consistency * periodWeeks.length : 0;
            
            var delta = deltaByPseudo[pseudo] || 0;
            var gloryBonus = (delta > 0 && maxDelta > 0) ? (delta / maxDelta) * W.gloryMax * periodWeeks.length : 0;

            var totalScore = agg.eventsScore + gloryBonus + consistencyBonus;
            
            var formattedBreakdown = {};
            Object.keys(agg.perEvent).forEach(function(name) {
                var ev = agg.perEvent[name];
                if (ev.max > 0 || ev.total > 0 || ev.participated) {
                    formattedBreakdown[name] = {
                        coeff: ev.coeff,
                        participated: ev.participated,
                        score: ev.score,
                        base: round1(ev.base),
                        perf: round1(ev.perf),
                        total: round1(ev.total),
                        max: ev.max
                    };
                }
            });

            return {
                pseudo:           pseudo,
                score:            round1(totalScore),
                events_score:     round1(agg.eventsScore),
                events_done:      agg.eventsAttended,
                events_total:     agg.eventsTotal,
                attendance_rate:  attendanceRate,
                glory_delta:      delta,
                glory_bonus:      round1(gloryBonus),
                consistency_bonus: consistencyBonus,
                breakdown:        formattedBreakdown
            };
        }).sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.pseudo.localeCompare(b.pseudo);
        });

        return { scores: scores, maxPossible: round1(globalMaxPossible), ranEvents: globalRanEvents };
    }

    function round1(n) { return Math.round(n * 10) / 10; }

    // ── Render contrôles ────────────────────────────────────────────────────────
    function renderControls() {
        document.querySelectorAll('.stats-controls').forEach(function (el) {
            // Mode participation : pas de sélecteur de semaine (le sélecteur de
            // période est rendu inline dans la vue participation elle-même).
            if (currentMode === 'participation') {
                el.innerHTML = '';
                return;
            }

            var optHtml = allWeeks.map(function (w) {
                return '<option value="' + w + '"' + (w === currentWeek ? ' selected' : '') + '>' + window.RAD.formatWeek(w) + '</option>';
            }).join('');

            var periods = [
                { key: '1w', label: t('stats_period_1w') || '1 Semaine' },
                { key: '4w', label: t('stats_period_4w') || '4 Semaines' },
                { key: '8w', label: t('stats_period_8w') || '8 Semaines' }
            ];
            
            var periodOptHtml = periods.map(function (p) {
                return '<option value="' + p.key + '"' + (p.key === statsPeriod ? ' selected' : '') + '>' + esc(p.label) + '</option>';
            }).join('');

            el.innerHTML =
                '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap;">' +
                    '<select class="gm-select week-select" style="width:auto; min-width:180px;">' + optHtml + '</select>' +
                    '<select class="gm-select period-select" style="width:auto; min-width:140px;">' + periodOptHtml + '</select>' +
                '</div>';

            el.querySelector('.week-select').addEventListener('change', function () {
                currentWeek = this.value;
                refreshData();
            });

            el.querySelector('.period-select').addEventListener('change', function () {
                statsPeriod = this.value;
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
        var modes = statsModes();

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

            var isEvent  = mode === 'event';
            var isPrince = mode === 'prince';

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
                    (isPrince ? '<th class="gm-center">' + t('stats_uid') + '</th>' : '') +
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

                var uid = uidByPseudo[m.pseudo] || '';
                var uidCell = uid
                    ? '<span class="gm-uid-cell" data-uid="' + esc(uid) + '">' +
                          '<span class="gm-mono">' + esc(uid) + '</span>' +
                          '<button class="gm-mini-btn gm-uid-copy" type="button" title="' + t('stats_uid_copy') + '">' +
                              '<i class="ph ph-copy"></i>' +
                          '</button>' +
                      '</span>'
                    : '<span class="gm-dim" title="' + t('stats_uid_none') + '">—</span>';

                tableHtml +=
                    '<tr>' +
                        '<td class="gm-center gm-num" data-label="#">' + rankCell + '</td>' +
                        '<td data-label="' + t('col_member') + '">' +
                            '<div class="gm-row" style="gap:.6rem;">' +
                                '<div class="gm-avatar">' + esc(initial) + '</div>' +
                                '<strong>' + esc(m.pseudo) + '</strong>' +
                            '</div>' +
                        '</td>' +
                        (isPrince ? '<td class="gm-center" data-label="' + t('stats_uid') + '">' + uidCell + '</td>' : '') +
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
            container.querySelectorAll('.gm-uid-copy').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var cell = btn.closest('.gm-uid-cell');
                    var uid  = cell ? cell.getAttribute('data-uid') : '';
                    if (!uid || !navigator.clipboard) return;
                    navigator.clipboard.writeText(uid).then(function () {
                        var icon = btn.querySelector('i');
                        icon.className = 'ph ph-check';
                        window.RAD.showToast(t('stats_uid_copied'), 'success');
                        setTimeout(function () { icon.className = 'ph ph-copy'; }, 2000);
                    });
                });
            });
        });
    }

    function wireStatsTabs(container) {
        container.querySelectorAll('[data-gm-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                currentMode = btn.getAttribute('data-gm-mode');
                renderControls();
                refreshData();
            });
        });
    }

    function renderEmpty() {
        document.querySelectorAll('.stats-leaderboard-area').forEach(function (el) {
            el.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-chart-bar"></i><p>' + t('stats_no_data') + '</p></div>';
        });
    }

    // ── Profil membre ───────────────────────────────────────────────────────────
    // Calcule pour chaque semaine de l'historique global la note du joueur, son rang
    // dans la guilde, et conserve le breakdown par événement. Permet ensuite de
    // dériver des métriques d'évolution réelle (tendance mobile, présence cumulée,
    // évolution par événement) au lieu d'un simple snapshot.
    async function openProfile(pseudo) {
        var [membersRes, partsRes, gloryRes, squadsRes, coeffSvs, coeffGvg, coeffShadowfront, coeffDtr, coeffArmsrace] = await Promise.all([
            db.from('guild_members').select('pseudo'),
            db.from('event_participants').select('*').neq('event_name', 'Glory').limit(100000),
            db.from('event_participants').select('pseudo, score, week_start').eq('event_name', 'Glory').limit(100000),
            db.from('shadowfront_squads').select('pseudo, role, week_start').limit(100000),
            window.RAD.config.get('coeff_svs'),
            window.RAD.config.get('coeff_gvg'),
            window.RAD.config.get('coeff_shadowfront'),
            window.RAD.config.get('coeff_dtr'),
            window.RAD.config.get('coeff_armsrace')
        ]);
        var allMembers = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var allParts   = deduplicateParticipants(partsRes.data || []);
        var allGlory   = gloryRes.data || [];
        var allSquads  = squadsRes.data || [];

        var config = {
            coeff_svs: parseInt(coeffSvs, 10) || 5,
            coeff_gvg: parseInt(coeffGvg, 10) || 5,
            coeff_shadowfront: parseInt(coeffShadowfront, 10) || 3,
            coeff_dtr: parseInt(coeffDtr, 10) || 2,
            coeff_armsrace: parseInt(coeffArmsrace, 10) || 1
        };

        var weeks = Array.from(new Set(allParts.map(function (r) { return r.week_start; }))).sort();

        var history = weeks.map(function (w) {
            var weekParts = allParts.filter(function (r) { return r.week_start === w; });
            var weekSquads = allSquads.filter(function (s) { return s.week_start === w; });
            var prev = window.RAD.getPrevWeekStart(w);
            var glorySpanW = [prev, w];
            var gloryByWeek = buildGloryByWeek(allGlory.filter(function (r) {
                return glorySpanW.indexOf(r.week_start) !== -1;
            }), glorySpanW);
            var result = computeScores(allMembers, weekParts, gloryByWeek, [w], config, weekSquads);

            // Rang basé sur les participants actifs (au moins un événement OU gain de gloire).
            var active = result.scores.filter(function (s) {
                return s.events_done > 0 || s.glory_delta > 0;
            });
            var rank = -1;
            for (var i = 0; i < active.length; i++) {
                if (active[i].pseudo === pseudo) { rank = i + 1; break; }
            }

            var found = result.scores.find(function (s) { return s.pseudo === pseudo; });
            var base = {
                week_start:   w,
                max_possible: result.maxPossible,
                rank:         rank,
                active_count: active.length
            };
            return found
                ? Object.assign(base, found)
                : Object.assign(base, {
                      score: 0, events_score: 0, events_done: 0, events_total: 0,
                      attendance_rate: 0, glory_delta: 0, glory_bonus: 0,
                      consistency_bonus: 0, breakdown: {}
                  });
        }).filter(function (r) { return r.events_done > 0 || r.glory_delta > 0; });

        renderProfileModal(pseudo, history);
    }

    // Agrège l'historique en métriques d'évolution : tendance mobile, présence
    // cumulée, séries, statistiques par événement. Tout ce que la modale affiche
    // dérive d'ici (la vue est sans logique).
    function computeProfileMetrics(history) {
        var n = history.length;
        var empty = {
            n: 0, avg: 0, avgPct: 0,
            best: null, worst: null,
            totalGlory: 0, totalAttended: 0, totalPossible: 0, attendancePct: 0,
            avgRank: null, bestRank: null,
            streak: 0, trend: null, eventStats: {}, achievements: []
        };
        if (n === 0) return empty;

        var totalScore = 0;
        var pctSum = 0, pctCount = 0;
        var totalGlory = 0;
        var totalAttended = 0;
        var totalPossible = 0;
        var ranks = [];
        var best = history[0];
        var worst = history[0];

        history.forEach(function (r) {
            totalScore += r.score;
            if (r.max_possible > 0) { pctSum += r.score / r.max_possible; pctCount++; }
            totalGlory += r.glory_delta || 0;
            totalAttended += r.events_done || 0;
            totalPossible += r.events_total || 0;
            if (r.rank > 0) ranks.push(r.rank);
            if (r.score > best.score) best = r;
            if (r.score < worst.score) worst = r;
        });

        var avg = round1(totalScore / n);
        var avgPct = pctCount > 0 ? pctSum / pctCount : 0;
        var attendancePct = totalPossible > 0 ? totalAttended / totalPossible : 0;
        var avgRank = ranks.length ? Math.round(ranks.reduce(function (s, r) { return s + r; }, 0) / ranks.length) : null;
        var bestRank = ranks.length ? Math.min.apply(null, ranks) : null;

        // Série courante : nombre de semaines consécutives (en fin d'historique)
        // avec au moins un événement participé.
        var streak = 0;
        for (var i = history.length - 1; i >= 0; i--) {
            if (history[i].events_done > 0) streak++;
            else break;
        }

        // Tendance = moyenne des K dernières semaines vs les K précédentes (K ≤ 4).
        // Plus fiable qu'un simple delta semaine-N vs semaine-N-1.
        var trend = null;
        if (n >= 2) {
            var win = Math.min(4, Math.floor(n / 2));
            if (win >= 1) {
                var recent = history.slice(-win).reduce(function (s, r) { return s + r.score; }, 0) / win;
                var prev   = history.slice(-2 * win, -win);
                if (prev.length === win) {
                    var prevAvg = prev.reduce(function (s, r) { return s + r.score; }, 0) / win;
                    trend = {
                        delta:     round1(recent - prevAvg),
                        recentAvg: round1(recent),
                        prevAvg:   round1(prevAvg),
                        window:    win
                    };
                }
            }
            if (!trend) {
                trend = {
                    delta:     round1(history[n - 1].score - history[n - 2].score),
                    recentAvg: round1(history[n - 1].score),
                    prevAvg:   round1(history[n - 2].score),
                    window:    1
                };
            }
        }

        // Évolution par événement : sur toutes les semaines où l'événement a tourné,
        // combien le joueur a participé, score moyen / meilleur, points cumulés.
        var eventStats = {};
        history.forEach(function (r) {
            if (!r.breakdown) return;
            Object.keys(r.breakdown).forEach(function (name) {
                var b = r.breakdown[name];
                if (!eventStats[name]) {
                    eventStats[name] = {
                        name:          name,
                        coeff:         b.coeff,
                        weeksRan:      0,
                        weeksAttended: 0,
                        scores:        [],
                        totalPoints:   0,
                        maxPoints:     0,
                        lastDelta:     null
                    };
                }
                var s = eventStats[name];
                s.weeksRan++;
                s.maxPoints   += b.max   || 0;
                s.totalPoints += b.total || 0;
                if (b.participated) {
                    s.weeksAttended++;
                    if (b.score > 0) s.scores.push(b.score);
                }
            });
        });

        var achievements = [];
        
        var activeWeeks = history.filter(function (r) { return r.events_done > 0; });
        if (activeWeeks.length >= 4) {
            var last4 = activeWeeks.slice(-4);
            var ironMan = last4.every(function (r) { return r.events_done === r.events_total; });
            if (ironMan) {
                achievements.push({
                    key: 'iron_man',
                    label: t('badge_iron_man') || 'Iron Man',
                    desc: t('badge_iron_man_desc') || '100% de présence sur les 4 dernières semaines actives.',
                    icon: 'ph-shield-check',
                    color: 'var(--success)'
                });
            }
        }
        
        var reachedRank1 = history.some(function (r) { return r.rank === 1; });
        if (reachedRank1) {
            achievements.push({
                key: 'mvp',
                label: 'MVP',
                desc: t('badge_mvp_desc') || 'Finished first in the weekly guild ranking.',
                icon: 'ph-crown',
                color: 'oklch(0.78 0.16 75)'
            });
        }
        
        if (totalGlory >= 5000) {
            achievements.push({
                key: 'glory_climber',
                label: t('badge_glory_climber') || 'Glory Climber',
                desc: t('badge_glory_climber_desc') || 'Accumulated over 5,000 Glory progression points.',
                icon: 'ph-trend-up',
                color: 'var(--accent)'
            });
        }
        
        if (totalAttended >= 15) {
            achievements.push({
                key: 'loyal_soldier',
                label: t('badge_loyal_soldier') || 'Loyal Soldier',
                desc: t('badge_loyal_soldier_desc') || 'Participated in 15 or more guild events.',
                icon: 'ph-sword',
                color: 'var(--info)'
            });
        }
        
        var consistencyCount = history.filter(function (r) { return r.consistency_bonus > 0; }).length;
        if (consistencyCount >= 4) {
            achievements.push({
                key: 'consistency_master',
                label: t('badge_consistency_master') || 'Consistency Master',
                desc: t('badge_consistency_master_desc') || 'Obtained the attendance bonus for at least 4 weeks.',
                icon: 'ph-calendar-check',
                color: 'var(--warning)'
            });
        }

        return {
            n: n,
            avg: avg, avgPct: avgPct,
            best: best, worst: worst,
            totalGlory: totalGlory,
            totalAttended: totalAttended, totalPossible: totalPossible, attendancePct: attendancePct,
            avgRank: avgRank, bestRank: bestRank,
            streak: streak, trend: trend,
            eventStats: eventStats,
            achievements: achievements
        };
    }

    function renderProfileModal(pseudo, history) {
        var existing = document.getElementById('profile-modal');
        if (existing) existing.remove();

        var m = computeProfileMetrics(history);

        var modal = document.createElement('div');
        modal.id = 'profile-modal';
        modal.className = 'confirm-overlay';

        // ── Header ────────────────────────────────────────────────────────────
        var trendChip = '';
        if (m.trend !== null) {
            var d = m.trend.delta;
            var stable = Math.abs(d) < 1;
            var cls    = stable ? 'gm-chip' : (d > 0 ? 'gm-chip gm-chip-success' : 'gm-chip gm-chip-danger');
            var icon   = stable ? 'ph-arrows-left-right' : (d > 0 ? 'ph-trend-up' : 'ph-trend-down');
            var label  = stable ? t('stats_trend_stable') : (d > 0 ? t('stats_trend_improving') : t('stats_trend_declining'));
            var title  = t('stats_trend_window').replace('{0}', m.trend.window) +
                         ' : ' + fmt(m.trend.recentAvg) + ' vs ' + fmt(m.trend.prevAvg);
            var sign   = d > 0 ? '+' : '';
            trendChip = '<span class="' + cls + '" title="' + esc(title) + '">' +
                        '<i class="ph ' + icon + '"></i> ' + label +
                        (stable ? '' : ' (' + sign + d + ' ' + t('stats_pts') + ')') +
                        '</span>';
        }

        var achievementsHtml = '';
        if (m.achievements && m.achievements.length > 0) {
            achievementsHtml = '<div class="profile-achievements-row" style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.4rem;">' +
                m.achievements.map(function (a) {
                    return '<span class="gm-chip profile-achievement-badge" style="background: rgba(255,255,255,0.04); border: 1px solid ' + a.color + '40; color: ' + a.color + '; font-size:0.75rem; padding: 0.15rem 0.45rem; font-weight: 500;" title="' + esc(a.desc) + '">' +
                        '<i class="ph ' + a.icon + '" style="margin-right:0.2rem; font-size:0.85rem; vertical-align:middle;"></i>' + esc(a.label) +
                    '</span>';
                }).join('') +
            '</div>';
        }

        var html =
            '<div class="profile-card glass-card">' +
                '<div class="profile-header">' +
                    '<div class="profile-avatar"><i class="ph-fill ph-user-circle"></i></div>' +
                    '<div class="profile-info">' +
                        '<h2 class="text-gradient">' + esc(pseudo) + '</h2>' +
                        '<div class="profile-meta-row">' +
                            '<span class="gm-chip"><i class="ph-fill ph-calendar"></i> ' + m.n + ' ' + t('stats_weeks') + '</span>' +
                            trendChip +
                        '</div>' +
                        achievementsHtml +
                    '</div>' +
                    '<button class="icon-btn profile-close" title="' + t('close_title') + '"><i class="ph ph-x"></i></button>' +
                '</div>';

        if (m.n === 0) {
            html += '<div class="gm-empty"><i class="ph-duotone ph-chart-bar gm-icon"></i>' +
                    '<div class="gm-empty-title">' + t('stats_no_data') + '</div></div></div>';
            modal.innerHTML = html;
            document.body.appendChild(modal);
            requestAnimationFrame(function () { modal.classList.add('visible'); });
            modal.querySelector('.profile-close').addEventListener('click', function () { closeModal(modal); });
            modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(modal); });
            return;
        }

        // ── KPI grid (4 cartes épurées) ──────────────────────────────────────
        var kpis = [
            {
                icon: 'ph-trophy', cls: 'kpi-accent',
                label: t('stats_kpi_avg_score'),
                value: fmt(m.avg),
                sub:   Math.round(m.avgPct * 100) + '% ' + t('stats_kpi_of_max')
            },
            {
                icon: 'ph-check-circle', cls: 'kpi-info',
                label: t('stats_kpi_attendance'),
                value: m.totalAttended + ' / ' + m.totalPossible,
                sub:   Math.round(m.attendancePct * 100) + '%'
            },
            {
                icon: 'ph-fire', cls: 'kpi-warning',
                label: t('stats_kpi_glory_total'),
                value: m.totalGlory > 0 ? '+' + fmt(m.totalGlory) : '—',
                sub:   t('stats_kpi_cumulated')
            },
            {
                icon: 'ph-lightning', cls: 'kpi-accent',
                label: t('stats_kpi_streak'),
                value: m.streak + ' ' + t('stats_weeks'),
                sub:   t('stats_kpi_streak_sub')
            }
        ];

        html += '<div class="profile-kpis">';
        kpis.forEach(function (k) {
            html += '<div class="kpi-card ' + k.cls + '">' +
                        '<div class="kpi-icon"><i class="ph-fill ' + k.icon + '"></i></div>' +
                        '<div class="kpi-body">' +
                            '<div class="kpi-label">' + k.label + '</div>' +
                            '<div class="kpi-value">' + k.value + '</div>' +
                            (k.sub ? '<div class="kpi-sub">' + k.sub + '</div>' : '') +
                        '</div>' +
                    '</div>';
        });
        html += '</div>';

        // ── Sparkline (score brut + moyenne mobile) ──────────────────────────
        if (m.n >= 2) {
            html += '<div class="profile-sparkline" style="position:relative;">' +
                        '<div class="sparkline-legend">' +
                            '<span><span class="sp-swatch sp-swatch-score"></span>' + t('stats_score_pts') + '</span>' +
                            (m.n >= 3 ? '<span><span class="sp-swatch sp-swatch-ma"></span>' + t('stats_moving_avg') + '</span>' : '') +
                            '<span><span class="sp-swatch sp-swatch-max"></span>' + t('stats_max_line') + '</span>' +
                        '</div>' +
                        buildSparkline(history) +
                        '<div id="sp-tooltip" class="glass-card sparkline-tooltip" style="position:absolute; display:none; pointer-events:none; z-index:10; padding:0.5rem; font-size:0.75rem; border-radius:6px; background:rgba(15,23,42,0.92); border:1px solid rgba(255,255,255,0.1); color:#fff; box-shadow:0 4px 16px rgba(0,0,0,0.6); transform:translateX(-50%); white-space:nowrap; top:-10px; transition: left 0.1s ease, top 0.1s ease;"></div>' +
                    '</div>';
        }

        // Helper pour générer un mini-badge pour la participation à un événement
        function renderEventChip(key, breakdownInfo) {
            if (!breakdownInfo) return '';
            var label = key;
            var clsBase = 'default';

            if (key.indexOf('ARMS RACE') !== -1 || key.indexOf('Arms Race') !== -1) {
                label = key.replace(/ARMS RACE/i, 'AR');
                clsBase = 'armsrace';
            } else if (key.indexOf('Shadowfront') !== -1) {
                label = key.replace(/Shadowfront/i, 'SF');
                clsBase = 'shadowfront';
            } else if (key.indexOf('Defend Trade Route') !== -1 || key === 'DTR') {
                label = key.replace(/Defend Trade Route/i, 'DTR');
                clsBase = 'dtr';
            } else if (key === 'SvS') {
                clsBase = 'svs';
            } else if (key === 'GvG') {
                clsBase = 'gvg';
            }
            
            var participated = breakdownInfo.participated;
            var cls = participated ? 'mini-chip-' + clsBase + ' participated' : 'mini-chip-missed';
            var icon = participated ? 'ph-check-circle' : 'ph-x-circle';
            var title = key + ' : ' + (participated ? 'Présent' : 'Non participé') + ' (Score: ' + (breakdownInfo.score > 0 ? breakdownInfo.score : '—') + ')';
            
            return '<span class="gm-mini-chip ' + cls + '" title="' + esc(title) + '">' +
                       '<i class="ph ' + icon + '"></i>' + esc(label) +
                   '</span>';
        }

        // ── Unification : Tableau Unique d'Historique et de Participation ────
        html +=
            '<div class="profile-history">' +
            '<h4><i class="ph ph-clock-counter-clockwise"></i> ' + t('stats_history') + ' & Participation</h4>' +
            '<div class="table-responsive" style="overflow-x:auto; -webkit-overflow-scrolling:touch; width:100%; border-radius:var(--radius-md); background:rgba(0,0,0,0.15); border:1px solid var(--card-border);">' +
            '<table class="leaderboard-table" style="width:100%;">' +
            '<thead><tr>' +
                '<th>' + t('stats_week') + '</th>' +
                '<th class="center">' + t('stats_rank') + '</th>' +
                '<th class="center">' + t('stats_score_pts') + '</th>' +
                '<th class="center" style="min-width: 220px;">' + t('stats_events') + '</th>' +
                '<th class="center">Δ ' + t('stats_glory') + '</th>' +
            '</tr></thead><tbody>';

        var reversed = history.slice().reverse();
        reversed.forEach(function (row, idx) {
            var ratio = row.max_possible > 0 ? row.score / row.max_possible : 0;
            var cls = ratio >= 0.7 ? 'score-high' : ratio >= 0.4 ? 'score-mid' : 'score-low';
            
            var rankCell = '';
            if (row.rank === 1) {
                rankCell = '<span class="score-badge" style="background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3); font-weight:700;"><i class="ph-fill ph-crown" style="margin-right:0.15rem; vertical-align:middle;"></i>#1</span>';
            } else if (row.rank > 0) {
                rankCell = '<strong>#' + row.rank + '</strong><span class="gm-dim">/' + row.active_count + '</span>';
            } else {
                rankCell = '<span class="gm-dim">—</span>';
            }

            // Direction = semaine courante vs semaine chronologiquement précédente
            var dir = '';
            if (idx < reversed.length - 1) {
                var dScore = row.score - reversed[idx + 1].score;
                if (Math.abs(dScore) >= 1) {
                    var up = dScore > 0;
                    dir = ' <i class="ph ' + (up ? 'ph-arrow-up' : 'ph-arrow-down') +
                          '" title="' + (up ? '+' : '') + round1(dScore) + ' ' + t('stats_pts') +
                          '" style="color:' + (up ? 'var(--success)' : 'var(--danger)') +
                          ';font-size:0.75rem;vertical-align:middle;margin-left:0.25rem;"></i>';
                }
            }

            // Génération des chips d'événements
            var chipsHtml = '<div style="display: flex; gap: 0.35rem; justify-content: center; flex-wrap: wrap; padding: 0.2rem 0;">';
            var eventKeys = row.breakdown ? Object.keys(row.breakdown).sort() : [];
            var hasEvents = false;
            eventKeys.forEach(function (key) {
                chipsHtml += renderEventChip(key, row.breakdown[key]);
                hasEvents = true;
            });
            if (!hasEvents) {
                chipsHtml += '<span class="gm-dim" style="font-size:0.75rem;">—</span>';
            }
            chipsHtml += '</div>';

            var gloryCell = row.glory_delta > 0
                ? '<span class="score-badge score-mid" style="font-weight:600;"><i class="ph ph-fire" style="vertical-align:middle;margin-right:0.15rem;"></i>+' + fmt(row.glory_delta) + '</span>'
                : '<span class="gm-dim">—</span>';

            html +=
                '<tr>' +
                '<td class="week-cell"><strong>' + window.RAD.formatWeek(row.week_start) + '</strong></td>' +
                '<td class="center">' + rankCell + '</td>' +
                '<td class="center"><span class="score-badge ' + cls + '">' + fmt(row.score) + ' / ' + fmt(row.max_possible) + '</span>' + dir + '</td>' +
                '<td class="center">' + chipsHtml + '</td>' +
                '<td class="center">' + gloryCell + '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        modal.innerHTML = html;
        document.body.appendChild(modal);
        requestAnimationFrame(function () { modal.classList.add('visible'); });

        // Register interactive sparkline tooltips
        var tooltipEl = modal.querySelector('#sp-tooltip');
        var highlightDot = modal.querySelector('#sp-highlight-dot');
        var hoverRects = modal.querySelectorAll('.sp-hover-rect');
        
        hoverRects.forEach(function (rect) {
            function showTooltip() {
                var dataStr = rect.getAttribute('data-tooltip');
                if (!dataStr) return;
                var d = JSON.parse(dataStr);
                
                tooltipEl.innerHTML = '<div style="font-weight:600; margin-bottom:0.25rem;">' + esc(d.week) + '</div>' +
                                      '<div style="display:flex; justify-content:space-between; gap:1rem;"><span>' + t('stats_score_pts') + ' :</span><strong>' + fmt(d.score) + ' / ' + fmt(d.max) + '</strong></div>' +
                                      (d.rank > 0 ? '<div style="display:flex; justify-content:space-between; gap:1rem; margin-top:0.15rem;"><span>' + t('stats_rank') + ' :</span><strong>#' + d.rank + '</strong></div>' : '');
                
                tooltipEl.style.display = 'block';
                var xPct = (d.x / 520) * 100;
                tooltipEl.style.left = xPct + '%';
                var yPct = (d.y / 122) * 100;
                tooltipEl.style.top = (yPct - 35) + '%';
                
                if (highlightDot) {
                    highlightDot.setAttribute('cx', d.x);
                    highlightDot.setAttribute('cy', d.y);
                    highlightDot.style.display = 'block';
                }
            }
            
            function hideTooltip() {
                if (tooltipEl) tooltipEl.style.display = 'none';
                if (highlightDot) highlightDot.style.display = 'none';
            }
            
            rect.addEventListener('mouseenter', showTooltip);
            rect.addEventListener('mouseleave', hideTooltip);
            rect.addEventListener('touchstart', function (e) {
                e.preventDefault();
                showTooltip();
            });
            rect.addEventListener('touchend', hideTooltip);
        });

        modal.querySelector('.profile-close').addEventListener('click', function () { closeModal(modal); });
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(modal); });
    }

    function closeModal(modal) {
        modal.classList.remove('visible');
        setTimeout(function () { modal.remove(); }, 300);
    }

    // ── SVG Sparkline : score brut + moyenne mobile + repère max théorique ──
    // L'échelle Y est calée sur le max théorique max parmi toutes les semaines
    // (pas seulement la première) pour rester cohérente quand les événements
    // qui ont tourné varient.
    function buildSparkline(history) {
        var scores = history.map(function (r) { return r.score; });
        var weeks  = history.map(function (r) { return r.week_start; });
        var maxesPossible = history.map(function (r) { return r.max_possible || 0; });
        var globalMax = Math.max.apply(null, maxesPossible.concat([0]));

        var W_ = 520, H = 110, px = 32, py = 14;
        var n = scores.length;
        var ymax = niceCeil(Math.max(globalMax, Math.max.apply(null, scores), 1));

        // Moyenne mobile (fenêtre = 3, ou tout si n < 3)
        var maWindow = Math.min(3, n);
        var maValues = scores.map(function (_, i) {
            var start = Math.max(0, i - maWindow + 1);
            var slice = scores.slice(start, i + 1);
            return slice.reduce(function (s, v) { return s + v; }, 0) / slice.length;
        });

        function projectX(i) {
            return px + (n === 1 ? (W_ - px * 2) / 2 : (i / (n - 1)) * (W_ - px * 2));
        }
        function projectY(v) {
            return H - py - (v / ymax) * (H - py * 2);
        }

        var pts = scores.map(function (s, i) {
            return [projectX(i).toFixed(1), projectY(s).toFixed(1)];
        });
        var maPts = maValues.map(function (v, i) {
            return [projectX(i).toFixed(1), projectY(v).toFixed(1)];
        });
        var maxPts = maxesPossible.map(function (v, i) {
            return [projectX(i).toFixed(1), projectY(v).toFixed(1)];
        });

        var line   = pts.map(function (p) { return p.join(','); }).join(' ');
        var maLine = maPts.map(function (p) { return p.join(','); }).join(' ');
        var maxLn  = maxPts.map(function (p) { return p.join(','); }).join(' ');
        var area   = (projectX(0).toFixed(1) + ',' + (H - py)) + ' ' + line + ' ' + (projectX(n - 1).toFixed(1) + ',' + (H - py));

        var dots = pts.map(function (p, i) {
            var cls = i === n - 1 ? 'sp-dot sp-dot-last' : 'sp-dot';
            return '<circle class="' + cls + '" cx="' + p[0] + '" cy="' + p[1] + '" r="3.5"/>';
        }).join('');

        var colW = n > 1 ? (W_ - px * 2) / (n - 1) : W_ - px * 2;
        var hoverRects = history.map(function (row, i) {
            var rx = projectX(i) - colW / 2;
            var tooltipData = {
                week: window.RAD.formatWeek(row.week_start),
                score: row.score,
                max: row.max_possible,
                rank: row.rank,
                x: projectX(i),
                y: projectY(row.score)
            };
            return '<rect class="sp-hover-rect" x="' + rx.toFixed(1) + '" y="0" width="' + colW.toFixed(1) + '" height="' + H + '" fill="transparent" style="cursor:pointer;" data-tooltip=\'' + JSON.stringify(tooltipData).replace(/'/g, "&apos;") + '\'/>';
        }).join('');

        var ticks = [0, ymax / 2, ymax];
        var yLines = ticks.map(function (v) {
            var y = projectY(v);
            return '<line x1="' + px + '" x2="' + (W_ - px) + '" y1="' + y + '" y2="' + y + '" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4"/>' +
                   '<text x="' + (px - 4) + '" y="' + (y + 4) + '" text-anchor="end" font-size="9" fill="#94a3b8">' + Math.round(v) + '</text>';
        }).join('');

        var step = Math.max(1, Math.floor(n / 6));
        var xLabels = '';
        for (var i = 0; i < n; i++) {
            if (i % step === 0 || i === n - 1) {
                var d = new Date(weeks[i] + 'T12:00:00Z');
                var label = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
                xLabels += '<text x="' + projectX(i).toFixed(1) + '" y="' + (H + 2) + '" text-anchor="middle" font-size="9" fill="#94a3b8">' + label + '</text>';
            }
        }

        return '<svg viewBox="0 0 ' + W_ + ' ' + (H + 12) + '" class="sparkline-svg" preserveAspectRatio="none" style="position:relative; overflow:visible;">' +
            '<defs><linearGradient id="sg1" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#6366f1" stop-opacity="0.35"/>' +
                '<stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            yLines +
            '<polyline points="' + maxLn + '" fill="none" stroke="rgba(148,163,184,0.5)" stroke-width="1.2" stroke-dasharray="2,3" stroke-linecap="round"/>' +
            '<polygon points="' + area + '" fill="url(#sg1)"/>' +
            '<polyline points="' + line + '" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            (maWindow >= 2
                ? '<polyline points="' + maLine + '" fill="none" stroke="#f59e0b" stroke-width="1.8" stroke-dasharray="5,3" stroke-linecap="round" stroke-linejoin="round"/>'
                : '') +
            dots + xLabels +
            hoverRects +
            '<circle id="sp-highlight-dot" r="4.5" fill="#f59e0b" stroke="#fff" stroke-width="1.5" style="display:none; pointer-events:none; transition: all 0.08s ease;"/>' +
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
