/**
 * gvg-matchup.js — Super Admin GvG Guild vs Guild Matchup & Dangerosity Ranking.
 * Fonctionne EXACTEMENT comme l'onglet SvS, mais au niveau Guilde :
 * - Liste déroulante principale Gauche : Choix de la GUILDE A (ex: ALPHA)
 * - Liste déroulante principale Droite : Choix de la GUILDE B (ex: OMEGA)
 * - Alignement parfait au pixel près (grid minmax(0, 1fr) avec max-width/ellipsis pour zéro débordement)
 * - Scores sur une seule ligne (white-space: nowrap + format compact K/M/B)
 * Source : RPC gm_gvg_player_matchup() (SECURITY DEFINER, superadmin only).
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var fmtPower = (window.GM && window.GM.formatPower) || function (n) { return String(n); };
    var fmtNum = (window.GM && window.GM.formatNumber) || function (n) {
        if (n == null || isNaN(n)) return '0';
        return Number(n).toLocaleString().replace(/\s/g, '\u00A0');
    };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    function fmtScore(n) {
        if (n == null || isNaN(n) || n === 0) return '-';
        if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 10000) return (n / 1000).toFixed(0) + 'K';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    var state = {
        rows: [],
        guildA: 'ALL',
        guildB: 'ALL',
        viewMode: 'side-by-side', // 'side-by-side' ou 'combined'
        sortKey: 'danger_score',
        sortDesc: true,
        query: ''
    };

    function getDb() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    function formatServerDisplay(rawServer) {
        if (!rawServer) return '—';
        var s = String(rawServer).trim();
        if (s.indexOf('#') === 0) return s;
        return '#' + s;
    }

    function computeDangerScore(r) {
        if (r.danger_score !== undefined && r.danger_score !== null) {
            return r.danger_score;
        }
        var p = r.power || 0;
        var prep = r.avg_prep_score || 0;
        var pvp = r.avg_pvp_score || 0;
        var raw = p + (prep * 2) + (pvp * 5);
        var mult = 1.0;
        if (p < 60000000) {
            mult = 0.30;
        } else if (p <= 90000000) {
            mult = 0.65;
        }
        return Math.round(raw * mult);
    }

    function getDangerBadge(tier, score) {
        var tUpper = String(tier || '').toUpperCase();
        if (tUpper === 'EXTREME') {
            return '<span class="gm-badge" style="background:rgba(239, 68, 68, 0.15); color:#f87171; border:1px solid rgba(239, 68, 68, 0.3); font-weight:800; font-size:0.65rem; padding:1px 5px; white-space:nowrap;"><i class="ph ph-fire-simple"></i> EXTREME</span>';
        }
        if (tUpper === 'HIGH') {
            return '<span class="gm-badge" style="background:rgba(249, 115, 22, 0.15); color:#fb923c; border:1px solid rgba(249, 115, 22, 0.3); font-weight:800; font-size:0.65rem; padding:1px 5px; white-space:nowrap;"><i class="ph ph-warning"></i> HIGH</span>';
        }
        if (tUpper === 'MEDIUM') {
            return '<span class="gm-badge" style="background:rgba(234, 179, 8, 0.15); color:#facc15; border:1px solid rgba(234, 179, 8, 0.3); font-weight:700; font-size:0.65rem; padding:1px 5px; white-space:nowrap;"><i class="ph ph-shield"></i> MEDIUM</span>';
        }
        return '<span class="gm-badge" style="background:rgba(34, 197, 94, 0.12); color:#4ade80; border:1px solid rgba(34, 197, 94, 0.25); font-weight:600; font-size:0.65rem; padding:1px 5px; white-space:nowrap;"><i class="ph ph-check-circle"></i> LOW</span>';
    }

    // ── Chargement des données ───────────────────────────────────────────────
    async function load() {
        var container = document.getElementById('gvg-matchup-container');
        if (!container) return;

        var db = getDb();
        if (!db) {
            container.innerHTML = loadingHtml();
            return;
        }

        if (!window.GM || !window.GM.isSuperAdmin()) {
            container.innerHTML =
                '<div class="gm-empty">' +
                    '<i class="ph-duotone ph-shield-warning gm-icon"></i>' +
                    '<div class="gm-empty-title">' + (t('gm_settings_denied') || 'Super admin only') + '</div>' +
                '</div>';
            return;
        }

        container.innerHTML = loadingHtml();

        try {
            var query = db.rpc('gm_gvg_player_matchup');
            if (query && typeof query.range === 'function') {
                query = query.range(0, 99999);
            }
            var res = await query;
            if (res && res.error) {
                container.innerHTML = errorHtml(res.error.message || 'RPC failed');
                wireRetry(container);
                return;
            }
            state.rows = ((res && res.data) || []).filter(function (r) {
                return r.guild !== 'DEMO';
            });

            // Auto-sélection des 2 premières guildes si non encore configurées
            var gList = guildList();
            if (gList.length >= 2 && state.guildA === 'ALL' && state.guildB === 'ALL') {
                state.guildA = gList[0].id;
                state.guildB = gList[1].id;
            } else if (gList.length >= 1 && state.guildA === 'ALL') {
                state.guildA = gList[0].id;
            }

            render(container);
        } catch (err) {
            container.innerHTML = errorHtml((err && err.message) || 'Failed to load GvG matchup data');
            wireRetry(container);
        }
    }

    function wireRetry(container) {
        var btn = document.getElementById('gvg-matchup-retry');
        if (btn) btn.addEventListener('click', load);
    }

    function guildList() {
        var map = {};
        state.rows.forEach(function (r) {
            if (!r.guild || r.guild === 'DEMO') return;
            if (!map[r.guild]) {
                map[r.guild] = { id: r.guild, server: r.server_number != null ? String(r.server_number) : '' };
            }
        });
        var list = [];
        Object.keys(map).forEach(function (k) {
            list.push(map[k]);
        });
        return list.sort(function (a, b) {
            return a.id.localeCompare(b.id);
        });
    }

    function filterRows(guildId) {
        var q = state.query.trim().toLowerCase();
        return state.rows.filter(function (r) {
            if (r.guild === 'DEMO') return false;
            if (guildId !== 'ALL' && r.guild !== guildId) return false;
            if (!q) return true;
            var pseudoStr = String(r.pseudo || '').toLowerCase();
            var guildStr = String(r.guild || '').toLowerCase();
            var serverStr = String(r.server_number || '').toLowerCase();
            return (pseudoStr.indexOf(q) !== -1 || guildStr.indexOf(q) !== -1 || serverStr.indexOf(q) !== -1);
        });
    }

    function sortRows(rows, sortKey, sortDesc) {
        var list = rows.slice(0);
        list.sort(function (a, b) {
            var dir = sortDesc ? -1 : 1;
            var av, bv;
            if (sortKey === 'pseudo') {
                av = String(a.pseudo || '').toLowerCase();
                bv = String(b.pseudo || '').toLowerCase();
                return av.localeCompare(bv) * dir;
            }
            if (sortKey === 'guild') {
                av = String(a.guild || '').toLowerCase();
                bv = String(b.guild || '').toLowerCase();
                if (av !== bv) return av.localeCompare(bv) * dir;
                return (b.power || 0) - (a.power || 0);
            }
            if (sortKey === 'danger_score') {
                av = computeDangerScore(a);
                bv = computeDangerScore(b);
            } else {
                av = a[sortKey] || 0;
                bv = b[sortKey] || 0;
            }
            if (av !== bv) return (av - bv) * dir;
            return (b.power || 0) - (a.power || 0);
        });
        return list;
    }

    function computeStats(rows) {
        var totalPower = 0;
        var totalPrep = 0;
        var totalPvp = 0;
        var totalDanger = 0;
        var extremeCount = 0;
        var highCount = 0;

        rows.forEach(function (r) {
            totalPower += (r.power || 0);
            totalPrep += (r.avg_prep_score || 0);
            totalPvp += (r.avg_pvp_score || 0);
            totalDanger += computeDangerScore(r);
            var tier = String(r.danger_tier || '').toUpperCase();
            if (tier === 'EXTREME') extremeCount++;
            if (tier === 'HIGH') highCount++;
        });

        return {
            count: rows.length,
            totalPower: totalPower,
            avgPrep: rows.length ? Math.round(totalPrep / rows.length) : 0,
            avgPvp: rows.length ? Math.round(totalPvp / rows.length) : 0,
            avgDanger: rows.length ? Math.round(totalDanger / rows.length) : 0,
            extremeCount: extremeCount,
            highCount: highCount
        };
    }

    function getGuildServer(guildId) {
        for (var i = 0; i < state.rows.length; i++) {
            if (state.rows[i].guild === guildId && state.rows[i].server_number) {
                return formatServerDisplay(state.rows[i].server_number);
            }
        }
        return '—';
    }

    // ── Rendu de la vue ──────────────────────────────────────────────────────
    function render(container) {
        var guilds = guildList();

        var rowsA = sortRows(filterRows(state.guildA), state.sortKey, state.sortDesc);
        var rowsB = sortRows(filterRows(state.guildB), state.sortKey, state.sortDesc);

        var statsA = computeStats(rowsA);
        var statsB = computeStats(rowsB);

        // Barre d'outils et sélecteurs de Guildes A vs B (Grid minmax(0, 1fr) avec gap:1.25rem)
        var headerHtml =
            '<div class="gm-card glass-card gm-section" style="padding:1.25rem; margin-bottom:1.25rem;">' +
                '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; margin-bottom:1.25rem;">' +
                    '<div>' +
                        '<h2 style="margin:0; font-family:var(--font-display); font-size:1.3rem; display:flex; align-items:center; gap:.6rem;">' +
                            '<i class="ph ph-flag-banner" style="color:var(--accent);"></i> GvG Guild Matchup & Dangerosity' +
                        '</h2>' +
                        '<div class="gm-dim" style="font-size:0.8rem; margin-top:.2rem;">' +
                            'Compare full player rosters of Guild A vs Guild B with Day 1-5 Avg & Day 6 Castle Battle Avg scores.' +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex; gap:.5rem;">' +
                        '<button id="gvg-mode-side" class="gm-btn ' + (state.viewMode === 'side-by-side' ? 'gm-btn-primary' : 'gm-btn-secondary') + '" style="font-weight:600; padding:.4rem .8rem; font-size:.8rem;">' +
                            '<i class="ph ph-columns"></i> Side by Side Rosters' +
                        '</button>' +
                        '<button id="gvg-mode-combined" class="gm-btn ' + (state.viewMode === 'combined' ? 'gm-btn-primary' : 'gm-btn-secondary') + '" style="font-weight:600; padding:.4rem .8rem; font-size:.8rem;">' +
                            '<i class="ph ph-list-numbers"></i> Combined Roster Ranking' +
                        '</button>' +
                    '</div>' +
                '</div>' +

                '<!-- Matchup Guild Selectors: Grille minmax(0, 1fr) minmax(0, 1fr) alignée -->' +
                '<div style="position:relative; display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap:1.25rem; align-items:center;">' +
                    '<!-- Guild A Selection -->' +
                    '<div style="background:rgba(59, 130, 246, 0.08); border:1px solid rgba(59, 130, 246, 0.25); border-radius:12px; padding:.75rem 1rem;">' +
                        '<div style="font-weight:800; color:#60a5fa; font-size:0.8rem; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.4rem; display:flex; align-items:center; gap:.4rem;">' +
                            '<i class="ph ph-shield-star"></i> Guild A (Defender / Attacker)' +
                        '</div>' +
                        '<select id="gvg-select-guild-a" class="gm-input" style="width:100%; font-weight:700; font-size:1rem;">' +
                            '<option value="ALL">All Guilds</option>' +
                            guilds.map(function (g) {
                                var label = esc(g.id) + ' (Server ' + esc(formatServerDisplay(g.server)) + ')';
                                return '<option value="' + esc(g.id) + '"' + (state.guildA === g.id ? ' selected' : '') + '>' + label + '</option>';
                            }).join('') +
                        '</select>' +
                    '</div>' +

                    '<!-- VS Badge Absolument Centré sur le gap -->' +
                    '<div style="position:absolute; left:50%; top:50%; transform:translate(-50%, -50%); z-index:5; pointer-events:none;">' +
                        '<div style="width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg, #ef4444, #f97316); color:#fff; display:flex; align-items:center; justify-content:center; font-family:var(--font-display); font-weight:900; font-size:.95rem; box-shadow:0 4px 15px rgba(239,68,68,0.5); border:2px solid rgba(255,255,255,0.25);">' +
                            'VS' +
                        '</div>' +
                    '</div>' +

                    '<!-- Guild B Selection -->' +
                    '<div style="background:rgba(239, 68, 68, 0.08); border:1px solid rgba(239, 68, 68, 0.25); border-radius:12px; padding:.75rem 1rem;">' +
                        '<div style="font-weight:800; color:#f87171; font-size:0.8rem; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.4rem; display:flex; align-items:center; gap:.4rem;">' +
                            '<i class="ph ph-crosshair"></i> Guild B (Opponent / Target)' +
                        '</div>' +
                        '<select id="gvg-select-guild-b" class="gm-input" style="width:100%; font-weight:700; font-size:1rem;">' +
                            '<option value="ALL">All Guilds</option>' +
                            guilds.map(function (g) {
                                var label = esc(g.id) + ' (Server ' + esc(formatServerDisplay(g.server)) + ')';
                                return '<option value="' + esc(g.id) + '"' + (state.guildB === g.id ? ' selected' : '') + '>' + label + '</option>';
                            }).join('') +
                        '</select>' +
                    '</div>' +
                '</div>' +

                '<!-- Search Bar -->' +
                '<div style="margin-top:1rem; display:flex; gap:1rem; align-items:center;">' +
                    '<div class="gm-input-with-icon" style="flex:1;">' +
                        '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                        '<input type="text" id="gvg-matchup-search" class="gm-input" value="' + esc(state.query) + '" placeholder="Search player pseudo or guild name...">' +
                    '</div>' +
                '</div>' +
            '</div>';

        // Cartes de synthèse comparatives des 2 guildes
        var comparisonCardsHtml = renderComparisonCards(statsA, statsB);

        var contentHtml = '';
        if (state.viewMode === 'side-by-side') {
            contentHtml = renderSideBySideView(rowsA, rowsB);
        } else {
            contentHtml = renderCombinedView(rowsA.concat(rowsB));
        }

        container.innerHTML = headerHtml + comparisonCardsHtml + contentHtml;
        wireControls(container);
    }

    // ── Cartes de Synthèse Comparatives des 2 Guildes ────────────────────────
    function renderComparisonCards(statsA, statsB) {
        var sA = getGuildServer(state.guildA);
        var sB = getGuildServer(state.guildB);

        return '<div style="display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap:1.25rem; margin-bottom:1.25rem;">' +
            '<!-- Guild A Summary -->' +
            '<div class="gm-card glass-card" style="padding:1.1rem; border-left:4px solid #3b82f6;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:.85rem;">' +
                    '<div>' +
                        '<div style="font-weight:800; font-size:1.05rem; color:#60a5fa;">' + esc(state.guildA === 'ALL' ? 'All Guilds' : state.guildA) + ' <span style="font-size:0.8rem; color:var(--fg-dim); font-weight:600;">(Server ' + esc(sA) + ')</span></div>' +
                        '<div class="gm-dim" style="font-size:0.78rem;">' + statsA.count + ' players analyzed</div>' +
                    '</div>' +
                    '<div style="text-align:right;">' +
                        '<div style="font-weight:800; font-size:1.15rem; font-variant-numeric:tabular-nums; color:var(--fg);">' + fmtPower(statsA.totalPower) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.72rem;">Total Guild Power</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:.5rem; background:rgba(0,0,0,0.2); padding:.6rem; border-radius:8px; text-align:center;">' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.68rem; text-transform:uppercase;">Day 1-5 Avg</div>' +
                        '<div style="font-weight:700; color:var(--fg); font-size:.82rem; white-space:nowrap;">' + fmtScore(statsA.avgPrep) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.68rem; text-transform:uppercase;">Day 6 Avg</div>' +
                        '<div style="font-weight:800; color:#f87171; font-size:.82rem; white-space:nowrap;">' + fmtScore(statsA.avgPvp) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.68rem; text-transform:uppercase;">Threats</div>' +
                        '<div style="font-weight:800; color:#fb923c; font-size:.82rem; white-space:nowrap;">' + (statsA.extremeCount + statsA.highCount) + ' High+</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<!-- Guild B Summary -->' +
            '<div class="gm-card glass-card" style="padding:1.1rem; border-left:4px solid #ef4444;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:.85rem;">' +
                    '<div>' +
                        '<div style="font-weight:800; font-size:1.05rem; color:#f87171;">' + esc(state.guildB === 'ALL' ? 'All Guilds' : state.guildB) + ' <span style="font-size:0.8rem; color:var(--fg-dim); font-weight:600;">(Server ' + esc(sB) + ')</span></div>' +
                        '<div class="gm-dim" style="font-size:0.78rem;">' + statsB.count + ' players analyzed</div>' +
                    '</div>' +
                    '<div style="text-align:right;">' +
                        '<div style="font-weight:800; font-size:1.15rem; font-variant-numeric:tabular-nums; color:var(--fg);">' + fmtPower(statsB.totalPower) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.72rem;">Total Guild Power</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:.5rem; background:rgba(0,0,0,0.2); padding:.6rem; border-radius:8px; text-align:center;">' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.68rem; text-transform:uppercase;">Day 1-5 Avg</div>' +
                        '<div style="font-weight:700; color:var(--fg); font-size:.82rem; white-space:nowrap;">' + fmtScore(statsB.avgPrep) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.68rem; text-transform:uppercase;">Day 6 Avg</div>' +
                        '<div style="font-weight:800; color:#f87171; font-size:.82rem; white-space:nowrap;">' + fmtScore(statsB.avgPvp) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.68rem; text-transform:uppercase;">Threats</div>' +
                        '<div style="font-weight:800; color:#fb923c; font-size:.82rem; white-space:nowrap;">' + (statsB.extremeCount + statsB.highCount) + ' High+</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    // ── Vue Side-by-Side (Deux Tableaux Côte à Côte sans Débordement) ────────
    function renderSideBySideView(rowsA, rowsB) {
        return '<div style="display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap:1.25rem;">' +
            '<!-- Guild A Roster Table -->' +
            '<div class="gm-card glass-card" style="padding:.85rem; overflow:hidden;">' +
                '<div style="font-weight:800; font-size:0.9rem; color:#60a5fa; margin-bottom:.65rem; display:flex; align-items:center; justify-content:space-between;">' +
                    '<span><i class="ph ph-shield"></i> ' + esc(state.guildA === 'ALL' ? 'All Guilds' : state.guildA) + ' Roster</span>' +
                    '<span class="gm-dim" style="font-size:.78rem; font-weight:600;">' + rowsA.length + ' players</span>' +
                '</div>' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse; font-size:0.8rem;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:24px; white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">#</th>' +
                            '<th style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Member</th>' +
                            '<th class="gm-center" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Server</th>' +
                            '<th class="gm-right" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Power</th>' +
                            '<th class="gm-right" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;" title="Day 1 to 5 Average Prep Score">Day 1-5</th>' +
                            '<th class="gm-right" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;" title="Day 6 Average Castle Battle Score">Day 6</th>' +
                            '<th class="gm-center" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Threat</th>' +
                        '</tr></thead><tbody>' +
                            renderPlayerRows(rowsA) +
                        '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +

            '<!-- Guild B Roster Table -->' +
            '<div class="gm-card glass-card" style="padding:.85rem; overflow:hidden;">' +
                '<div style="font-weight:800; font-size:0.9rem; color:#f87171; margin-bottom:.65rem; display:flex; align-items:center; justify-content:space-between;">' +
                    '<span><i class="ph ph-crosshair"></i> ' + esc(state.guildB === 'ALL' ? 'All Guilds' : state.guildB) + ' Roster</span>' +
                    '<span class="gm-dim" style="font-size:.78rem; font-weight:600;">' + rowsB.length + ' players</span>' +
                '</div>' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse; font-size:0.8rem;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:24px; white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">#</th>' +
                            '<th style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Member</th>' +
                            '<th class="gm-center" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Server</th>' +
                            '<th class="gm-right" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Power</th>' +
                            '<th class="gm-right" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;" title="Day 1 to 5 Average Prep Score">Day 1-5</th>' +
                            '<th class="gm-right" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;" title="Day 6 Average Castle Battle Score">Day 6</th>' +
                            '<th class="gm-center" style="white-space:nowrap; padding:.35rem .2rem; font-size:.7rem;">Threat</th>' +
                        '</tr></thead><tbody>' +
                            renderPlayerRows(rowsB) +
                        '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderPlayerRows(rows) {
        if (!rows || rows.length === 0) {
            return '<tr><td colspan="7" class="gm-center" style="padding:1.5rem; color:var(--fg-dim);">No players found.</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(r.pseudo) : (r.pseudo ? String(r.pseudo).charAt(0).toUpperCase() : '?');
            var sDisplay = formatServerDisplay(r.server_number);
            var dScore = computeDangerScore(r);
            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700; color:var(--fg-dim); white-space:nowrap; padding:.3rem .2rem; font-size:.75rem;">' + (idx + 1) + '</td>' +
                    '<td style="white-space:nowrap; padding:.3rem .2rem; max-width:110px;">' +
                        '<div style="display:flex; align-items:center; gap:.4rem; overflow:hidden;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:22px; height:22px; font-size:.7rem; font-weight:700; flex-shrink:0;">' + esc(initial) + '</div>' +
                            '<strong style="color:var(--fg); font-size:.78rem; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="' + esc(r.pseudo) + '">' + esc(r.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center" style="white-space:nowrap; padding:.3rem .2rem;">' +
                        '<span style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); border-radius:4px; padding:1px 5px; font-weight:700; font-size:.65rem;">' + esc(sDisplay) + '</span>' +
                    '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.78rem; padding:.3rem .2rem;">' + fmtPower(r.power) + '</td>' +
                    '<td class="gm-right" style="font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.78rem; color:var(--fg); padding:.3rem .2rem;" title="' + fmtNum(r.avg_prep_score) + '">' + fmtScore(r.avg_prep_score) + '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.78rem; color:#f87171; padding:.3rem .2rem;" title="' + fmtNum(r.avg_pvp_score) + '">' + fmtScore(r.avg_pvp_score) + '</td>' +
                    '<td class="gm-center" style="white-space:nowrap; padding:.3rem .2rem;">' + getDangerBadge(r.danger_tier, dScore) + '</td>' +
                '</tr>';
        });
        return html;
    }

    // ── Vue Combinée Leaderboard (Grand Tableau Unique) ──────────────────────
    function renderCombinedView(allRows) {
        var rows = sortRows(allRows, state.sortKey, state.sortDesc);

        function header(key, label) {
            var arrow = (state.sortKey === key) ? (state.sortDesc ? ' ▼' : ' ▲') : '';
            return '<th data-sort="' + key + '" style="cursor:pointer; white-space:nowrap; user-select:none;">' + label + '<span class="gm-dim">' + arrow + '</span></th>';
        }

        return '<div class="gm-card glass-card" style="padding:1.25rem;">' +
            '<div style="font-weight:800; font-size:1.05rem; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center;">' +
                '<span>Cross-Guild GvG Player Dangerosity Leaderboard</span>' +
                '<span class="gm-dim" style="font-size:0.85rem;">' + rows.length + ' players total</span>' +
            '</div>' +
            '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                    '<thead><tr>' +
                        '<th class="gm-center" style="width:50px; white-space:nowrap;">#</th>' +
                        header('pseudo', 'Member') +
                        header('guild', 'Guild') +
                        header('server', 'Server') +
                        '<th class="gm-right" data-sort="power" style="cursor:pointer; white-space:nowrap;">Power</th>' +
                        '<th class="gm-right" data-sort="avg_prep_score" style="cursor:pointer; white-space:nowrap;" title="Average Day 1 to 5 Prep score">Day 1-5 Avg</th>' +
                        '<th class="gm-right" data-sort="avg_pvp_score" style="cursor:pointer; white-space:nowrap;" title="Average Day 6 Castle Battle score">Day 6 Avg</th>' +
                        '<th class="gm-right" data-sort="danger_score" style="cursor:pointer; white-space:nowrap;">Danger Score</th>' +
                        '<th class="gm-center" data-sort="danger_tier" style="cursor:pointer; white-space:nowrap;">Danger Tier</th>' +
                    '</tr></thead><tbody>' +
                        renderCombinedRows(rows) +
                    '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
    }

    function renderCombinedRows(rows) {
        if (!rows || rows.length === 0) {
            return '<tr><td colspan="9" class="gm-center" style="padding:2.5rem; color:var(--fg-dim);">No players match the selected criteria.</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(r.pseudo) : (r.pseudo ? String(r.pseudo).charAt(0).toUpperCase() : '?');
            var sDisplay = formatServerDisplay(r.server_number);
            var dScore = computeDangerScore(r);

            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700; white-space:nowrap;">' + (idx + 1) + '</td>' +
                    '<td style="white-space:nowrap;">' +
                        '<div style="display:flex; align-items:center; gap:.75rem;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:32px; height:32px; font-size:.85rem; font-weight:700;">' + esc(initial) + '</div>' +
                            '<strong style="color:var(--fg); font-weight:700;">' + esc(r.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center" style="white-space:nowrap;">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.72rem;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td class="gm-center" style="white-space:nowrap;">' +
                        '<span style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.75rem;">' + esc(sDisplay) + '</span>' +
                    '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap;">' + fmtPower(r.power) + '</td>' +
                    '<td class="gm-right" style="font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap;" title="' + fmtNum(r.avg_prep_score) + '">' + fmtScore(r.avg_prep_score) + '</td>' +
                    '<td class="gm-right" style="font-weight:800; font-variant-numeric:tabular-nums; color:#f87171; white-space:nowrap;" title="' + fmtNum(r.avg_pvp_score) + '">' + fmtScore(r.avg_pvp_score) + '</td>' +
                    '<td class="gm-right" style="font-weight:900; font-variant-numeric:tabular-nums; color:var(--accent); white-space:nowrap;">' + fmtScore(dScore) + '</td>' +
                    '<td class="gm-center" style="white-space:nowrap;">' + getDangerBadge(r.danger_tier, dScore) + '</td>' +
                '</tr>';
        });
        return html;
    }

    // ── Événements et Interactions ───────────────────────────────────────────
    function wireControls(container) {
        var modeSide = document.getElementById('gvg-mode-side');
        if (modeSide) {
            modeSide.addEventListener('click', function () {
                state.viewMode = 'side-by-side';
                render(container);
            });
        }
        var modeCombined = document.getElementById('gvg-mode-combined');
        if (modeCombined) {
            modeCombined.addEventListener('click', function () {
                state.viewMode = 'combined';
                render(container);
            });
        }

        var selA = document.getElementById('gvg-select-guild-a');
        if (selA) {
            selA.addEventListener('change', function () {
                state.guildA = selA.value;
                render(container);
            });
        }
        var selB = document.getElementById('gvg-select-guild-b');
        if (selB) {
            selB.addEventListener('change', function () {
                state.guildB = selB.value;
                render(container);
            });
        }

        var searchInput = document.getElementById('gvg-matchup-search');
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                state.query = searchInput.value;
                render(container);
                var updatedSearch = document.getElementById('gvg-matchup-search');
                if (updatedSearch) {
                    updatedSearch.focus();
                    updatedSearch.setSelectionRange(updatedSearch.value.length, updatedSearch.value.length);
                }
            });
        }

        container.querySelectorAll('th[data-sort]').forEach(function (th) {
            th.addEventListener('click', function () {
                var key = th.getAttribute('data-sort');
                if (state.sortKey === key) {
                    state.sortDesc = !state.sortDesc;
                } else {
                    state.sortKey = key;
                    state.sortDesc = true;
                }
                render(container);
            });
        });
    }

    function loadingHtml() {
        return '<div class="gm-empty"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">' + (t('loading') || 'Loading') + '…</div></div>';
    }

    function errorHtml(msg) {
        return '<div class="gm-empty">' +
            '<i class="ph-duotone ph-warning-circle gm-icon"></i>' +
            '<div class="gm-empty-title">' + (t('gm_settings_load_error') || 'Could not load GvG matchup data') + '</div>' +
            '<div class="gm-empty-hint">' + esc(msg) + '</div>' +
            '<button class="gm-btn gm-btn-primary" id="gvg-matchup-retry" style="margin-top:.5rem;"><i class="ph ph-arrow-clockwise"></i> ' + (t('gm_settings_retry') || 'Retry') + '</button>' +
        '</div>';
    }

    window.GM_GVG_MATCHUP = {
        load: load
    };

})();
