/**
 * gvg-matchup.js — Super Admin GvG Guild vs Guild Matchup & Dangerosity Ranking.
 * Permet de comparer les GUILDES d'un serveur vs les GUILDES d'un autre serveur,
 * avec leurs statistiques complètes et leur scoring de dangerosité GvG dans les journées
 * "Day 1 to 5" (Préparation) et "Day 6" (Combat de château).
 * Source : RPC gm_gvg_guild_matchup() (SECURITY DEFINER, superadmin only).
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
        if (n == null || isNaN(n) || n === 0) return '—';
        if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 10000) return (n / 1000).toFixed(0) + 'K';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    var state = {
        rows: [],
        serverA: 'ALL',
        serverB: 'ALL',
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
        var p = r.total_power || 0;
        var prep = r.total_prep_score || (r.avg_prep_score * r.member_count) || 0;
        var pvp = r.total_pvp_score || (r.avg_pvp_score * r.member_count) || 0;
        var raw = p + (prep * 2) + (pvp * 5);
        var mult = 1.0;
        if (p < 1500000000) {
            mult = 0.40;
        } else if (p <= 3500000000) {
            mult = 0.70;
        }
        return Math.round(raw * mult);
    }

    function getDangerBadge(tier, score) {
        var tUpper = String(tier || '').toUpperCase();
        if (tUpper === 'EXTREME') {
            return '<span class="gm-badge" style="background:rgba(239, 68, 68, 0.15); color:#f87171; border:1px solid rgba(239, 68, 68, 0.3); font-weight:800; font-size:0.7rem; white-space:nowrap;"><i class="ph ph-fire-simple"></i> EXTREME</span>';
        }
        if (tUpper === 'HIGH') {
            return '<span class="gm-badge" style="background:rgba(249, 115, 22, 0.15); color:#fb923c; border:1px solid rgba(249, 115, 22, 0.3); font-weight:800; font-size:0.7rem; white-space:nowrap;"><i class="ph ph-warning"></i> HIGH</span>';
        }
        if (tUpper === 'MEDIUM') {
            return '<span class="gm-badge" style="background:rgba(234, 179, 8, 0.15); color:#facc15; border:1px solid rgba(234, 179, 8, 0.3); font-weight:700; font-size:0.7rem; white-space:nowrap;"><i class="ph ph-shield"></i> MEDIUM</span>';
        }
        return '<span class="gm-badge" style="background:rgba(34, 197, 94, 0.12); color:#4ade80; border:1px solid rgba(34, 197, 94, 0.25); font-weight:600; font-size:0.7rem; white-space:nowrap;"><i class="ph ph-check-circle"></i> LOW</span>';
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
            var query = db.rpc('gm_gvg_guild_matchup');
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

            // Auto-sélection des 2 premiers serveurs s'ils ne sont pas encore configurés
            var sList = serverList();
            if (sList.length >= 2 && state.serverA === 'ALL' && state.serverB === 'ALL') {
                state.serverA = sList[0];
                state.serverB = sList[1];
            } else if (sList.length >= 1 && state.serverA === 'ALL') {
                state.serverA = sList[0];
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

    function serverList() {
        var set = [];
        state.rows.forEach(function (r) {
            if (r.guild === 'DEMO') return;
            var s = r.server_number != null ? String(r.server_number) : '';
            if (s && set.indexOf(s) === -1) set.push(s);
        });
        return set.sort();
    }

    function filterRows(serverNum) {
        var q = state.query.trim().toLowerCase();
        return state.rows.filter(function (r) {
            if (r.guild === 'DEMO') return false;
            var sVal = r.server_number != null ? String(r.server_number) : '';
            if (serverNum !== 'ALL' && sVal !== serverNum) return false;
            if (!q) return true;
            var guildStr = String(r.guild || '').toLowerCase();
            var serverStr = sVal.toLowerCase();
            return (guildStr.indexOf(q) !== -1 || serverStr.indexOf(q) !== -1);
        });
    }

    function sortRows(rows, sortKey, sortDesc) {
        var list = rows.slice(0);
        list.sort(function (a, b) {
            var dir = sortDesc ? -1 : 1;
            var av, bv;
            if (sortKey === 'guild') {
                av = String(a.guild || '').toLowerCase();
                bv = String(b.guild || '').toLowerCase();
                return av.localeCompare(bv) * dir;
            }
            if (sortKey === 'danger_score') {
                av = computeDangerScore(a);
                bv = computeDangerScore(b);
            } else {
                av = a[sortKey] || 0;
                bv = b[sortKey] || 0;
            }
            if (av !== bv) return (av - bv) * dir;
            return (b.total_power || 0) - (a.total_power || 0);
        });
        return list;
    }

    function computeStats(rows) {
        var totalPower = 0;
        var totalMembers = 0;
        var totalPrep = 0;
        var totalPvp = 0;
        var totalDanger = 0;
        var extremeCount = 0;
        var highCount = 0;

        rows.forEach(function (r) {
            totalPower += (r.total_power || 0);
            totalMembers += (r.member_count || 0);
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
            totalMembers: totalMembers,
            avgPrep: rows.length ? Math.round(totalPrep / rows.length) : 0,
            avgPvp: rows.length ? Math.round(totalPvp / rows.length) : 0,
            avgDanger: rows.length ? Math.round(totalDanger / rows.length) : 0,
            extremeCount: extremeCount,
            highCount: highCount
        };
    }

    // ── Rendu de la vue ──────────────────────────────────────────────────────
    function render(container) {
        var servers = serverList();

        var rowsA = sortRows(filterRows(state.serverA), state.sortKey, state.sortDesc);
        var rowsB = sortRows(filterRows(state.serverB), state.sortKey, state.sortDesc);

        var statsA = computeStats(rowsA);
        var statsB = computeStats(rowsB);

        // Barre d'outils et sélecteurs de Matchup
        var headerHtml =
            '<div class="gm-card glass-card gm-section" style="padding:1.5rem; margin-bottom:1.5rem;">' +
                '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; margin-bottom:1.25rem;">' +
                    '<div>' +
                        '<h2 style="margin:0; font-family:var(--font-display); font-size:1.4rem; display:flex; align-items:center; gap:.6rem;">' +
                            '<i class="ph ph-flag-banner" style="color:var(--accent);"></i> GvG Guild Matchup & Dangerosity' +
                        '</h2>' +
                        '<div class="gm-dim" style="font-size:0.85rem; margin-top:.25rem;">' +
                            'Compare Server vs Server guild rosters with Day 1-5 Avg & Day 6 Avg scores and guild power penalties.' +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex; gap:.5rem;">' +
                        '<button id="gvg-mode-side" class="gm-btn ' + (state.viewMode === 'side-by-side' ? 'gm-btn-primary' : 'gm-btn-secondary') + '" style="font-weight:600;">' +
                            '<i class="ph ph-columns"></i> Side by Side Guilds' +
                        '</button>' +
                        '<button id="gvg-mode-combined" class="gm-btn ' + (state.viewMode === 'combined' ? 'gm-btn-primary' : 'gm-btn-secondary') + '" style="font-weight:600;">' +
                            '<i class="ph ph-list-numbers"></i> Combined Guild Ranking' +
                        '</button>' +
                    '</div>' +
                '</div>' +

                '<!-- Matchup Server Selectors -->' +
                '<div style="display:grid; grid-template-columns: 1fr auto 1fr; gap:1rem; align-items:center;">' +
                    '<!-- Server A Selection -->' +
                    '<div style="background:rgba(59, 130, 246, 0.08); border:1px solid rgba(59, 130, 246, 0.25); border-radius:12px; padding:1rem;">' +
                        '<div style="font-weight:800; color:#60a5fa; font-size:0.85rem; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.5rem; display:flex; align-items:center; gap:.4rem;">' +
                            '<i class="ph ph-shield-star"></i> Server A Guilds' +
                        '</div>' +
                        '<select id="gvg-select-server-a" class="gm-input" style="width:100%; font-weight:700;">' +
                            '<option value="ALL">All Servers</option>' +
                            servers.map(function (s) {
                                return '<option value="' + esc(s) + '"' + (state.serverA === s ? ' selected' : '') + '>Server ' + esc(formatServerDisplay(s)) + '</option>';
                            }).join('') +
                        '</select>' +
                    '</div>' +

                    '<!-- VS Badge -->' +
                    '<div style="text-align:center;">' +
                        '<div style="width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg, #ef4444, #f97316); color:#fff; display:flex; align-items:center; justify-content:center; font-family:var(--font-display); font-weight:900; font-size:1.1rem; box-shadow:0 4px 15px rgba(239,68,68,0.4); border:2px solid rgba(255,255,255,0.2);">' +
                            'VS' +
                        '</div>' +
                    '</div>' +

                    '<!-- Server B Selection -->' +
                    '<div style="background:rgba(239, 68, 68, 0.08); border:1px solid rgba(239, 68, 68, 0.25); border-radius:12px; padding:1rem;">' +
                        '<div style="font-weight:800; color:#f87171; font-size:0.85rem; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.5rem; display:flex; align-items:center; gap:.4rem;">' +
                            '<i class="ph ph-crosshair"></i> Server B Guilds' +
                        '</div>' +
                        '<select id="gvg-select-server-b" class="gm-input" style="width:100%; font-weight:700;">' +
                            '<option value="ALL">All Servers</option>' +
                            servers.map(function (s) {
                                return '<option value="' + esc(s) + '"' + (state.serverB === s ? ' selected' : '') + '>Server ' + esc(formatServerDisplay(s)) + '</option>';
                            }).join('') +
                        '</select>' +
                    '</div>' +
                '</div>' +

                '<!-- Search Bar -->' +
                '<div style="margin-top:1rem; display:flex; gap:1rem; align-items:center;">' +
                    '<div class="gm-input-with-icon" style="flex:1;">' +
                        '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                        '<input type="text" id="gvg-matchup-search" class="gm-input" value="' + esc(state.query) + '" placeholder="Search guild name or server number...">' +
                    '</div>' +
                '</div>' +
            '</div>';

        // Cartes de synthèse comparatives des 2 serveurs
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

    // ── Cartes de Synthèse Comparatives ──────────────────────────────────────
    function renderComparisonCards(statsA, statsB) {
        return '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.25rem; margin-bottom:1.5rem;">' +
            '<!-- Server A Guild Summary -->' +
            '<div class="gm-card glass-card" style="padding:1.25rem; border-left:4px solid #3b82f6;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">' +
                    '<div>' +
                        '<div style="font-weight:800; font-size:1.1rem; color:#60a5fa;">Server ' + esc(formatServerDisplay(state.serverA)) + ' Guilds</div>' +
                        '<div class="gm-dim" style="font-size:0.8rem;">' + statsA.count + ' guilds (' + statsA.totalMembers + ' members)</div>' +
                    '</div>' +
                    '<div style="text-align:right;">' +
                        '<div style="font-weight:800; font-size:1.2rem; font-variant-numeric:tabular-nums; color:var(--fg);">' + fmtPower(statsA.totalPower) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.75rem;">Guilds Total Power</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:.75rem; background:rgba(0,0,0,0.2); padding:.75rem; border-radius:8px; text-align:center;">' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 1-5 Avg</div>' +
                        '<div style="font-weight:700; color:var(--fg); font-size:.85rem; white-space:nowrap;">' + fmtScore(statsA.avgPrep) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 6 Avg</div>' +
                        '<div style="font-weight:800; color:#f87171; font-size:.85rem; white-space:nowrap;">' + fmtScore(statsA.avgPvp) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Guild Threats</div>' +
                        '<div style="font-weight:800; color:#fb923c; font-size:.85rem; white-space:nowrap;">' + (statsA.extremeCount + statsA.highCount) + ' High+</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<!-- Server B Guild Summary -->' +
            '<div class="gm-card glass-card" style="padding:1.25rem; border-left:4px solid #ef4444;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">' +
                    '<div>' +
                        '<div style="font-weight:800; font-size:1.1rem; color:#f87171;">Server ' + esc(formatServerDisplay(state.serverB)) + ' Guilds</div>' +
                        '<div class="gm-dim" style="font-size:0.8rem;">' + statsB.count + ' guilds (' + statsB.totalMembers + ' members)</div>' +
                    '</div>' +
                    '<div style="text-align:right;">' +
                        '<div style="font-weight:800; font-size:1.2rem; font-variant-numeric:tabular-nums; color:var(--fg);">' + fmtPower(statsB.totalPower) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.75rem;">Guilds Total Power</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:.75rem; background:rgba(0,0,0,0.2); padding:.75rem; border-radius:8px; text-align:center;">' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 1-5 Avg</div>' +
                        '<div style="font-weight:700; color:var(--fg); font-size:.85rem; white-space:nowrap;">' + fmtScore(statsB.avgPrep) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 6 Avg</div>' +
                        '<div style="font-weight:800; color:#f87171; font-size:.85rem; white-space:nowrap;">' + fmtScore(statsB.avgPvp) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Guild Threats</div>' +
                        '<div style="font-weight:800; color:#fb923c; font-size:.85rem; white-space:nowrap;">' + (statsB.extremeCount + statsB.highCount) + ' High+</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    // ── Vue Side-by-Side (Deux Tableaux de Guildes Côte à Côte) ──────────────
    function renderSideBySideView(rowsA, rowsB) {
        return '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.25rem;">' +
            '<!-- Server A Guilds Table -->' +
            '<div class="gm-card glass-card" style="padding:1rem;">' +
                '<div style="font-weight:800; font-size:0.95rem; color:#60a5fa; margin-bottom:.75rem; display:flex; align-items:center; justify-content:space-between;">' +
                    '<span><i class="ph ph-shield"></i> Server ' + esc(formatServerDisplay(state.serverA)) + ' Guilds</span>' +
                    '<span class="gm-dim" style="font-size:.8rem; font-weight:600;">' + rowsA.length + ' guilds</span>' +
                '</div>' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:30px; white-space:nowrap;">#</th>' +
                            '<th style="white-space:nowrap;">Guild</th>' +
                            '<th class="gm-center" style="white-space:nowrap;">Members</th>' +
                            '<th class="gm-right" style="white-space:nowrap;">Total Power</th>' +
                            '<th class="gm-right" style="white-space:nowrap;" title="Day 1 to 5 Average Prep Score per Member">Day 1-5 (Avg)</th>' +
                            '<th class="gm-right" style="white-space:nowrap;" title="Day 6 Average Castle Battle Score per Member">Day 6 (Avg)</th>' +
                            '<th class="gm-center" style="white-space:nowrap;">Threat</th>' +
                        '</tr></thead><tbody>' +
                            renderGuildRows(rowsA) +
                        '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +

            '<!-- Server B Guilds Table -->' +
            '<div class="gm-card glass-card" style="padding:1rem;">' +
                '<div style="font-weight:800; font-size:0.95rem; color:#f87171; margin-bottom:.75rem; display:flex; align-items:center; justify-content:space-between;">' +
                    '<span><i class="ph ph-crosshair"></i> Server ' + esc(formatServerDisplay(state.serverB)) + ' Guilds</span>' +
                    '<span class="gm-dim" style="font-size:.8rem; font-weight:600;">' + rowsB.length + ' guilds</span>' +
                '</div>' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:30px; white-space:nowrap;">#</th>' +
                            '<th style="white-space:nowrap;">Guild</th>' +
                            '<th class="gm-center" style="white-space:nowrap;">Members</th>' +
                            '<th class="gm-right" style="white-space:nowrap;">Total Power</th>' +
                            '<th class="gm-right" style="white-space:nowrap;" title="Day 1 to 5 Average Prep Score per Member">Day 1-5 (Avg)</th>' +
                            '<th class="gm-right" style="white-space:nowrap;" title="Day 6 Average Castle Battle Score per Member">Day 6 (Avg)</th>' +
                            '<th class="gm-center" style="white-space:nowrap;">Threat</th>' +
                        '</tr></thead><tbody>' +
                            renderGuildRows(rowsB) +
                        '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderGuildRows(rows) {
        if (!rows || rows.length === 0) {
            return '<tr><td colspan="7" class="gm-center" style="padding:2rem; color:var(--fg-dim);">No guilds found.</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var dScore = computeDangerScore(r);
            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700; color:var(--fg-dim); white-space:nowrap;">' + (idx + 1) + '</td>' +
                    '<td style="white-space:nowrap;">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:2px 8px; font-weight:800; font-size:.85rem; letter-spacing:.02em;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td class="gm-center" style="white-space:nowrap; font-weight:600; font-size:.8rem;">' + r.member_count + '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.82rem;">' + fmtPower(r.total_power) + '</td>' +
                    '<td class="gm-right" style="font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.82rem; color:var(--fg);" title="' + fmtNum(r.avg_prep_score) + '">' + fmtScore(r.avg_prep_score) + '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.82rem; color:#f87171;" title="' + fmtNum(r.avg_pvp_score) + '">' + fmtScore(r.avg_pvp_score) + '</td>' +
                    '<td class="gm-center" style="white-space:nowrap;">' + getDangerBadge(r.danger_tier, dScore) + '</td>' +
                '</tr>';
        });
        return html;
    }

    // ── Vue Combinée Leaderboard (Grand Tableau Unique de Guildes) ───────────
    function renderCombinedView(allRows) {
        var rows = sortRows(allRows, state.sortKey, state.sortDesc);

        function header(key, label) {
            var arrow = (state.sortKey === key) ? (state.sortDesc ? ' ▼' : ' ▲') : '';
            return '<th data-sort="' + key + '" style="cursor:pointer; white-space:nowrap; user-select:none;">' + label + '<span class="gm-dim">' + arrow + '</span></th>';
        }

        return '<div class="gm-card glass-card" style="padding:1.25rem;">' +
            '<div style="font-weight:800; font-size:1.05rem; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center;">' +
                '<span>Cross-Server GvG Guild Dangerosity Leaderboard</span>' +
                '<span class="gm-dim" style="font-size:0.85rem;">' + rows.length + ' guilds total</span>' +
            '</div>' +
            '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                    '<thead><tr>' +
                        '<th class="gm-center" style="width:50px; white-space:nowrap;">#</th>' +
                        header('guild', 'Guild') +
                        header('server', 'Server') +
                        header('member_count', 'Members') +
                        '<th class="gm-right" data-sort="total_power" style="cursor:pointer; white-space:nowrap;">Total Power</th>' +
                        '<th class="gm-right" data-sort="avg_power" style="cursor:pointer; white-space:nowrap;">Avg Power</th>' +
                        '<th class="gm-right" data-sort="avg_prep_score" style="cursor:pointer; white-space:nowrap;" title="Average Day 1 to 5 Prep score per member">Day 1-5 (Avg)</th>' +
                        '<th class="gm-right" data-sort="avg_pvp_score" style="cursor:pointer; white-space:nowrap;" title="Average Day 6 Castle Battle score per member">Day 6 (Avg)</th>' +
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
            return '<tr><td colspan="10" class="gm-center" style="padding:2.5rem; color:var(--fg-dim);">No guilds match the selected criteria.</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var sDisplay = formatServerDisplay(r.server_number);
            var dScore = computeDangerScore(r);

            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700; white-space:nowrap;">' + (idx + 1) + '</td>' +
                    '<td style="white-space:nowrap;">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:3px 10px; font-weight:800; font-size:.88rem;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td class="gm-center" style="white-space:nowrap;">' +
                        '<span style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.75rem;">' + esc(sDisplay) + '</span>' +
                    '</td>' +
                    '<td class="gm-center" style="white-space:nowrap; font-weight:600;">' + r.member_count + '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap;">' + fmtPower(r.total_power) + '</td>' +
                    '<td class="gm-right" style="font-variant-numeric:tabular-nums; white-space:nowrap; font-size:.82rem;">' + fmtPower(r.avg_power) + '</td>' +
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

        var selA = document.getElementById('gvg-select-server-a');
        if (selA) {
            selA.addEventListener('change', function () {
                state.serverA = selA.value;
                render(container);
            });
        }
        var selB = document.getElementById('gvg-select-server-b');
        if (selB) {
            selB.addEventListener('change', function () {
                state.serverB = selB.value;
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
