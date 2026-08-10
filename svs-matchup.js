/**
 * svs-matchup.js — Super Admin SvS Server vs Server Matchup & Dangerosity Ranking.
 * Permet de comparer les guildes d'un serveur vs les guildes d'un autre serveur,
 * avec la liste complète des joueurs et leur scoring de dangerosité pondéré selon la puissance :
 * - Puissance < 60M : gros malus (x0.30)
 * - Puissance 60M à 90M : malus modéré (x0.65)
 * - Puissance > 91M : dangerosité normale (x1.00)
 * Affiche les MOYENNES des scores "Day 1 to 5" (Préparation) et "Day 6" (PvP / Invasion).
 * Source : RPC gm_svs_server_matchup() (SECURITY DEFINER, superadmin only).
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var fmtPower = (window.GM && window.GM.formatPower) || function (n) { return String(n); };
    var fmtNum = (window.GM && window.GM.formatNumber) || function (n) {
        if (n == null || isNaN(n)) return '0';
        return Number(n).toLocaleString();
    };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    var state = {
        rows: [],
        serverA: 'ALL',
        serverB: 'ALL',
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
            return '<span class="gm-badge" style="background:rgba(239, 68, 68, 0.15); color:#f87171; border:1px solid rgba(239, 68, 68, 0.3); font-weight:800; font-size:0.75rem;"><i class="ph ph-fire-simple"></i> EXTREME</span>';
        }
        if (tUpper === 'HIGH') {
            return '<span class="gm-badge" style="background:rgba(249, 115, 22, 0.15); color:#fb923c; border:1px solid rgba(249, 115, 22, 0.3); font-weight:800; font-size:0.75rem;"><i class="ph ph-warning"></i> HIGH</span>';
        }
        if (tUpper === 'MEDIUM') {
            return '<span class="gm-badge" style="background:rgba(234, 179, 8, 0.15); color:#facc15; border:1px solid rgba(234, 179, 8, 0.3); font-weight:700; font-size:0.75rem;"><i class="ph ph-shield"></i> MEDIUM</span>';
        }
        return '<span class="gm-badge" style="background:rgba(34, 197, 94, 0.12); color:#4ade80; border:1px solid rgba(34, 197, 94, 0.25); font-weight:600; font-size:0.75rem;"><i class="ph ph-check-circle"></i> LOW</span>';
    }

    // ── Chargement des données ───────────────────────────────────────────────
    async function load() {
        var container = document.getElementById('svs-matchup-container');
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
            var query = db.rpc('gm_svs_server_matchup');
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
            container.innerHTML = errorHtml((err && err.message) || 'Failed to load SvS matchup data');
            wireRetry(container);
        }
    }

    function wireRetry(container) {
        var btn = document.getElementById('svs-matchup-retry');
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

    function guildListForServer(serverNum) {
        var set = [];
        state.rows.forEach(function (r) {
            if (r.guild === 'DEMO') return;
            var s = r.server_number != null ? String(r.server_number) : '';
            if (serverNum === 'ALL' || s === serverNum) {
                if (r.guild && set.indexOf(r.guild) === -1) set.push(r.guild);
            }
        });
        return set.sort();
    }

    function filterRows(serverNum, guildNum) {
        var q = state.query.trim().toLowerCase();
        return state.rows.filter(function (r) {
            if (r.guild === 'DEMO') return false;
            var sVal = r.server_number != null ? String(r.server_number) : '';
            if (serverNum !== 'ALL' && sVal !== serverNum) return false;
            if (guildNum !== 'ALL' && r.guild !== guildNum) return false;
            if (!q) return true;
            var pseudoStr = String(r.pseudo || '').toLowerCase();
            var guildStr = String(r.guild || '').toLowerCase();
            var serverStr = sVal.toLowerCase();
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

    // ── Rendu de la vue ──────────────────────────────────────────────────────
    function render(container) {
        var servers = serverList();
        var guildsA = guildListForServer(state.serverA);
        var guildsB = guildListForServer(state.serverB);

        var rowsA = sortRows(filterRows(state.serverA, state.guildA), state.sortKey, state.sortDesc);
        var rowsB = sortRows(filterRows(state.serverB, state.guildB), state.sortKey, state.sortDesc);

        var statsA = computeStats(rowsA);
        var statsB = computeStats(rowsB);

        // Barre d'outils et sélecteurs de Matchup
        var headerHtml =
            '<div class="gm-card glass-card gm-section" style="padding:1.5rem; margin-bottom:1.5rem;">' +
                '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; margin-bottom:1.25rem;">' +
                    '<div>' +
                        '<h2 style="margin:0; font-family:var(--font-display); font-size:1.4rem; display:flex; align-items:center; gap:.6rem;">' +
                            '<i class="ph ph-sword" style="color:var(--accent);"></i> SvS Server Matchup & Dangerosity' +
                        '</h2>' +
                        '<div class="gm-dim" style="font-size:0.85rem; margin-top:.25rem;">' +
                            'Compare Server vs Server player rosters with Day 1-5 Avg & Day 6 Avg scores and power penalties (<60M: -70% | 60-90M: -35% | >91M: Normal).' +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex; gap:.5rem;">' +
                        '<button id="svs-mode-side" class="gm-btn ' + (state.viewMode === 'side-by-side' ? 'gm-btn-primary' : 'gm-btn-secondary') + '" style="font-weight:600;">' +
                            '<i class="ph ph-columns"></i> Side by Side' +
                        '</button>' +
                        '<button id="svs-mode-combined" class="gm-btn ' + (state.viewMode === 'combined' ? 'gm-btn-primary' : 'gm-btn-secondary') + '" style="font-weight:600;">' +
                            '<i class="ph ph-list-numbers"></i> Combined Ranking' +
                        '</button>' +
                    '</div>' +
                '</div>' +

                '<!-- Matchup Server Selectors -->' +
                '<div style="display:grid; grid-template-columns: 1fr auto 1fr; gap:1rem; align-items:center;">' +
                    '<!-- Server A Selection -->' +
                    '<div style="background:rgba(59, 130, 246, 0.08); border:1px solid rgba(59, 130, 246, 0.25); border-radius:12px; padding:1rem;">' +
                        '<div style="font-weight:800; color:#60a5fa; font-size:0.85rem; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.5rem; display:flex; align-items:center; gap:.4rem;">' +
                            '<i class="ph ph-shield-star"></i> Server A (Defender / Attacker)' +
                        '</div>' +
                        '<div style="display:flex; gap:.5rem;">' +
                            '<select id="svs-select-server-a" class="gm-input" style="flex:1; font-weight:700;">' +
                                '<option value="ALL">All Servers</option>' +
                                servers.map(function (s) {
                                    return '<option value="' + esc(s) + '"' + (state.serverA === s ? ' selected' : '') + '>Server ' + esc(formatServerDisplay(s)) + '</option>';
                                }).join('') +
                            '</select>' +
                            '<select id="svs-select-guild-a" class="gm-input" style="width:auto; min-width:110px;">' +
                                '<option value="ALL">All Guilds</option>' +
                                guildsA.map(function (g) {
                                    return '<option value="' + esc(g) + '"' + (state.guildA === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                                }).join('') +
                            '</select>' +
                        '</div>' +
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
                            '<i class="ph ph-crosshair"></i> Server B (Opponent / Target)' +
                        '</div>' +
                        '<div style="display:flex; gap:.5rem;">' +
                            '<select id="svs-select-server-b" class="gm-input" style="flex:1; font-weight:700;">' +
                                '<option value="ALL">All Servers</option>' +
                                servers.map(function (s) {
                                    return '<option value="' + esc(s) + '"' + (state.serverB === s ? ' selected' : '') + '>Server ' + esc(formatServerDisplay(s)) + '</option>';
                                }).join('') +
                            '</select>' +
                            '<select id="svs-select-guild-b" class="gm-input" style="width:auto; min-width:110px;">' +
                                '<option value="ALL">All Guilds</option>' +
                                guildsB.map(function (g) {
                                    return '<option value="' + esc(g) + '"' + (state.guildB === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                                }).join('') +
                            '</select>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                '<!-- Search Bar -->' +
                '<div style="margin-top:1rem; display:flex; gap:1rem; align-items:center;">' +
                    '<div class="gm-input-with-icon" style="flex:1;">' +
                        '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                        '<input type="text" id="svs-matchup-search" class="gm-input" value="' + esc(state.query) + '" placeholder="Search player pseudo, guild, or server number...">' +
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

    // ── Cartes de Synthèse et Barres Comparatives ────────────────────────────
    function renderComparisonCards(statsA, statsB) {
        return '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.25rem; margin-bottom:1.5rem;">' +
            '<!-- Server A Summary -->' +
            '<div class="gm-card glass-card" style="padding:1.25rem; border-left:4px solid #3b82f6;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">' +
                    '<div>' +
                        '<div style="font-weight:800; font-size:1.1rem; color:#60a5fa;">Server ' + esc(formatServerDisplay(state.serverA)) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.8rem;">' + statsA.count + ' players analyzed</div>' +
                    '</div>' +
                    '<div style="text-align:right;">' +
                        '<div style="font-weight:800; font-size:1.2rem; font-variant-numeric:tabular-nums; color:var(--fg);">' + fmtPower(statsA.totalPower) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.75rem;">Total Power</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:.75rem; background:rgba(0,0,0,0.2); padding:.75rem; border-radius:8px; text-align:center;">' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 1-5 Avg</div>' +
                        '<div style="font-weight:700; color:var(--fg); font-size:.9rem;">' + fmtNum(statsA.avgPrep) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 6 Avg</div>' +
                        '<div style="font-weight:800; color:#f87171; font-size:.9rem;">' + fmtNum(statsA.avgPvp) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Threats</div>' +
                        '<div style="font-weight:800; color:#fb923c; font-size:.9rem;">' + (statsA.extremeCount + statsA.highCount) + ' High+</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<!-- Server B Summary -->' +
            '<div class="gm-card glass-card" style="padding:1.25rem; border-left:4px solid #ef4444;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">' +
                    '<div>' +
                        '<div style="font-weight:800; font-size:1.1rem; color:#f87171;">Server ' + esc(formatServerDisplay(state.serverB)) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.8rem;">' + statsB.count + ' players analyzed</div>' +
                    '</div>' +
                    '<div style="text-align:right;">' +
                        '<div style="font-weight:800; font-size:1.2rem; font-variant-numeric:tabular-nums; color:var(--fg);">' + fmtPower(statsB.totalPower) + '</div>' +
                        '<div class="gm-dim" style="font-size:0.75rem;">Total Power</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:.75rem; background:rgba(0,0,0,0.2); padding:.75rem; border-radius:8px; text-align:center;">' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 1-5 Avg</div>' +
                        '<div style="font-weight:700; color:var(--fg); font-size:.9rem;">' + fmtNum(statsB.avgPrep) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Day 6 Avg</div>' +
                        '<div style="font-weight:800; color:#f87171; font-size:.9rem;">' + fmtNum(statsB.avgPvp) + '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="gm-dim" style="font-size:.7rem; text-transform:uppercase;">Threats</div>' +
                        '<div style="font-weight:800; color:#fb923c; font-size:.9rem;">' + (statsB.extremeCount + statsB.highCount) + ' High+</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    // ── Vue Side-by-Side (Deux Tableaux Côte à Côte) ────────────────────────
    function renderSideBySideView(rowsA, rowsB) {
        return '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.25rem;">' +
            '<!-- Server A Table -->' +
            '<div class="gm-card glass-card" style="padding:1rem;">' +
                '<div style="font-weight:800; font-size:0.95rem; color:#60a5fa; margin-bottom:.75rem; display:flex; align-items:center; justify-content:space-between;">' +
                    '<span><i class="ph ph-shield"></i> Server ' + esc(formatServerDisplay(state.serverA)) + ' Roster</span>' +
                    '<span class="gm-dim" style="font-size:.8rem; font-weight:600;">' + rowsA.length + ' players</span>' +
                '</div>' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">' +
                        '<thead><tr>' +
                            '<th>#</th>' +
                            '<th>Member</th>' +
                            '<th class="gm-center">Guild</th>' +
                            '<th class="gm-right">Power</th>' +
                            '<th class="gm-right" title="Day 1 to 5 Average Prep Score">Day 1-5 (Avg)</th>' +
                            '<th class="gm-right" title="Day 6 Average PvP Score">Day 6 (Avg)</th>' +
                            '<th class="gm-center">Threat</th>' +
                        '</tr></thead><tbody>' +
                            renderRosterRows(rowsA) +
                        '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +

            '<!-- Server B Table -->' +
            '<div class="gm-card glass-card" style="padding:1rem;">' +
                '<div style="font-weight:800; font-size:0.95rem; color:#f87171; margin-bottom:.75rem; display:flex; align-items:center; justify-content:space-between;">' +
                    '<span><i class="ph ph-crosshair"></i> Server ' + esc(formatServerDisplay(state.serverB)) + ' Roster</span>' +
                    '<span class="gm-dim" style="font-size:.8rem; font-weight:600;">' + rowsB.length + ' players</span>' +
                '</div>' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse; font-size:0.85rem;">' +
                        '<thead><tr>' +
                            '<th>#</th>' +
                            '<th>Member</th>' +
                            '<th class="gm-center">Guild</th>' +
                            '<th class="gm-right">Power</th>' +
                            '<th class="gm-right" title="Day 1 to 5 Average Prep Score">Day 1-5 (Avg)</th>' +
                            '<th class="gm-right" title="Day 6 Average PvP Score">Day 6 (Avg)</th>' +
                            '<th class="gm-center">Threat</th>' +
                        '</tr></thead><tbody>' +
                            renderRosterRows(rowsB) +
                        '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderRosterRows(rows) {
        if (!rows || rows.length === 0) {
            return '<tr><td colspan="7" class="gm-center" style="padding:2rem; color:var(--fg-dim);">No players found.</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(r.pseudo) : (r.pseudo ? String(r.pseudo).charAt(0).toUpperCase() : '?');
            var dScore = computeDangerScore(r);
            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td style="font-weight:700; color:var(--fg-dim);">' + (idx + 1) + '</td>' +
                    '<td>' +
                        '<div style="display:flex; align-items:center; gap:.5rem;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:28px; height:28px; font-size:.8rem; font-weight:700;">' + esc(initial) + '</div>' +
                            '<strong style="color:var(--fg); font-size:.85rem;">' + esc(r.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:4px; padding:1px 6px; font-weight:700; font-size:.7rem;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums;">' + fmtPower(r.power) + '</td>' +
                    '<td class="gm-right" style="font-variant-numeric:tabular-nums; color:var(--fg);">' + (r.avg_prep_score > 0 ? fmtNum(r.avg_prep_score) : '—') + '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums; color:#f87171;">' + (r.avg_pvp_score > 0 ? fmtNum(r.avg_pvp_score) : '—') + '</td>' +
                    '<td class="gm-center">' + getDangerBadge(r.danger_tier, dScore) + '</td>' +
                '</tr>';
        });
        return html;
    }

    // ── Vue Combinée Leaderboard (Grand Tableau Unique) ─────────────────────
    function renderCombinedView(allRows) {
        var rows = sortRows(allRows, state.sortKey, state.sortDesc);

        function header(key, label) {
            var arrow = (state.sortKey === key) ? (state.sortDesc ? ' ▼' : ' ▲') : '';
            return '<th data-sort="' + key + '" style="cursor:pointer; white-space:nowrap; user-select:none;">' + label + '<span class="gm-dim">' + arrow + '</span></th>';
        }

        return '<div class="gm-card glass-card" style="padding:1.25rem;">' +
            '<div style="font-weight:800; font-size:1.05rem; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center;">' +
                '<span>Cross-Server Dangerosity Leaderboard</span>' +
                '<span class="gm-dim" style="font-size:0.85rem;">' + rows.length + ' players total</span>' +
            '</div>' +
            '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                    '<thead><tr>' +
                        '<th class="gm-center" style="width:50px;">#</th>' +
                        header('pseudo', 'Member') +
                        header('server', 'Server') +
                        header('guild', 'Guild') +
                        '<th class="gm-right" data-sort="power" style="cursor:pointer;">Power</th>' +
                        '<th class="gm-right" data-sort="avg_prep_score" style="cursor:pointer;" title="Average Day 1 to 5 Prep score">Day 1-5 Avg</th>' +
                        '<th class="gm-right" data-sort="avg_pvp_score" style="cursor:pointer;" title="Average Day 6 PvP score">Day 6 Avg</th>' +
                        '<th class="gm-right" data-sort="danger_score" style="cursor:pointer;">Danger Score</th>' +
                        '<th class="gm-center" data-sort="danger_tier" style="cursor:pointer;">Danger Tier</th>' +
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
                    '<td class="gm-center" style="font-weight:700;">' + (idx + 1) + '</td>' +
                    '<td>' +
                        '<div style="display:flex; align-items:center; gap:.75rem;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:34px; height:34px; font-size:.9rem; font-weight:700;">' + esc(initial) + '</div>' +
                            '<strong style="color:var(--fg); font-weight:700;">' + esc(r.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center">' +
                        '<span style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.75rem;">' + esc(sDisplay) + '</span>' +
                    '</td>' +
                    '<td class="gm-center">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.72rem;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums;">' + fmtPower(r.power) + '</td>' +
                    '<td class="gm-right" style="font-variant-numeric:tabular-nums; font-weight:600;">' + (r.avg_prep_score > 0 ? fmtNum(r.avg_prep_score) : '—') + '</td>' +
                    '<td class="gm-right" style="font-weight:800; font-variant-numeric:tabular-nums; color:#f87171;">' + (r.avg_pvp_score > 0 ? fmtNum(r.avg_pvp_score) : '—') + '</td>' +
                    '<td class="gm-right" style="font-weight:900; font-variant-numeric:tabular-nums; color:var(--accent);">' + fmtNum(dScore) + '</td>' +
                    '<td class="gm-center">' + getDangerBadge(r.danger_tier, dScore) + '</td>' +
                '</tr>';
        });
        return html;
    }

    // ── Événements et Interactions ───────────────────────────────────────────
    function wireControls(container) {
        var modeSide = document.getElementById('svs-mode-side');
        if (modeSide) {
            modeSide.addEventListener('click', function () {
                state.viewMode = 'side-by-side';
                render(container);
            });
        }
        var modeCombined = document.getElementById('svs-mode-combined');
        if (modeCombined) {
            modeCombined.addEventListener('click', function () {
                state.viewMode = 'combined';
                render(container);
            });
        }

        var selA = document.getElementById('svs-select-server-a');
        if (selA) {
            selA.addEventListener('change', function () {
                state.serverA = selA.value;
                state.guildA = 'ALL';
                render(container);
            });
        }
        var selB = document.getElementById('svs-select-server-b');
        if (selB) {
            selB.addEventListener('change', function () {
                state.serverB = selB.value;
                state.guildB = 'ALL';
                render(container);
            });
        }

        var gSelA = document.getElementById('svs-select-guild-a');
        if (gSelA) {
            gSelA.addEventListener('change', function () {
                state.guildA = gSelA.value;
                render(container);
            });
        }
        var gSelB = document.getElementById('svs-select-guild-b');
        if (gSelB) {
            gSelB.addEventListener('change', function () {
                state.guildB = gSelB.value;
                render(container);
            });
        }

        var searchInput = document.getElementById('svs-matchup-search');
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                state.query = searchInput.value;
                render(container);
                var updatedSearch = document.getElementById('svs-matchup-search');
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
            '<div class="gm-empty-title">' + (t('gm_settings_load_error') || 'Could not load SvS matchup data') + '</div>' +
            '<div class="gm-empty-hint">' + esc(msg) + '</div>' +
            '<button class="gm-btn gm-btn-primary" id="svs-matchup-retry" style="margin-top:.5rem;"><i class="ph ph-arrow-clockwise"></i> ' + (t('gm_settings_retry') || 'Retry') + '</button>' +
        '</div>';
    }

    window.GM_SVS_MATCHUP = {
        load: load
    };

})();
