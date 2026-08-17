/**
 * cross-rank.js — Cross-Guild Draft Ranking & Mercato ("Draft" tab, superadmin).
 * Inter-Server Migration Scouting & Combat Scoring Engine.
 * Consolidated view of all players across all guilds and servers:
 * - Draft Score: Composite recruitment index prioritizing Shadowfront attendance, SvS/GvG commitment, and Glory.
 * - Day 6 PvP: Battle score with 2x doubled factor for SvS & GvG warriors.
 * - Shadowfront: Priority 20v20 guild attendance rate.
 * - Glory: Total cumulative Glory points accumulated.
 * - Server Filtering: Fast target-server isolation for migration events.
 * Source: RPC gm_cross_guild_ranking() (SECURITY DEFINER, superadmin only).
 * Loaded on demand by app.js via window.GM_SETTINGS.load().
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var fmtPower = (window.GM && window.GM.formatPower) || function (n) { return String(n); };
    var fmtNumber = (window.GM && window.GM.formatNumber) || function (n) {
        if (n == null || isNaN(n)) return '0';
        return Number(n).toLocaleString().replace(/\s/g, '\u00A0');
    };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    var state = {
        rows: [],
        sortKey: 'draft_score',
        sortDesc: true,
        query: '',
        guild: 'ALL',
        server: 'ALL',
        preset: 'ALL'
    };

    function getDb() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    function rateColor(rate) {
        if (rate === null || rate === undefined) return '';
        if (rate >= 75) return 'var(--success)';
        if (rate >= 40) return 'var(--warning)';
        return 'var(--error)';
    }

    function formatServerDisplay(rawServer) {
        if (!rawServer) return '-';
        var s = String(rawServer).trim();
        if (s.indexOf('#') === 0) return s;
        return '#' + s;
    }

    function getPlayerPower(r) {
        return r.overall_power != null ? r.power || r.overall_power : (r.power || 0);
    }

    function getDraftScore(r) {
        if (r.draft_score !== null && r.draft_score !== undefined) {
            return r.draft_score;
        }
        var sf = r.shadow_rate != null ? r.shadow_rate : null;
        var svs = r.svs_rate != null ? r.svs_rate : null;
        var gvg = r.gvg_rate != null ? r.gvg_rate : null;
        var glob = r.global_rate != null ? r.global_rate : null;
        var glory = r.glory_rate != null ? r.glory_rate : null;

        var hasAny = (sf != null || svs != null || gvg != null || glob != null || glory != null || (r.global_total && r.global_total > 0));
        if (!hasAny) return null;

        var sfVal = sf || 0;
        var svsVal = svs || 0;
        var gvgVal = gvg || 0;
        var globVal = glob || 0;
        var gloryVal = glory || 0;

        // Composite Draft Score: 35% Shadowfront, 25% SvS, 25% GvG, 10% Other, 5% Glory
        var score = (sfVal * 0.35) + (svsVal * 0.25) + (gvgVal * 0.25) + (globVal * 0.10) + (gloryVal * 0.05);
        return Math.round(score * 10) / 10;
    }

    function getDay6PvPScore(r) {
        if (r.day6_pvp_score !== null && r.day6_pvp_score !== undefined) {
            return r.day6_pvp_score;
        }
        var svsPvp = r.svs_avg_pvp || 0;
        var gvgPvp = r.gvg_avg_pvp || 0;
        return (svsPvp * 2) + (gvgPvp * 2);
    }

    function getGloryDisplayVal(r) {
        if (r.glory_total != null && r.glory_total > 0) return r.glory_total;
        if (r.glory_attended != null && r.glory_attended > 0) return r.glory_attended * 1000;
        return 0;
    }

    // ── Load: Superadmin-only RPC ─────────────────────────────────────────────
    async function load() {
        var container = document.getElementById('cross-rank-container');
        if (!container) return;

        state.query = '';
        state.guild = 'ALL';
        state.server = 'ALL';
        state.preset = 'ALL';
        state.sortKey = 'draft_score';
        state.sortDesc = true;

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
            var query = db.rpc('gm_cross_guild_ranking');
            if (query && typeof query.range === 'function') {
                query = query.range(0, 99999);
            }
            var res = await query;
            if (res && res.error) {
                container.innerHTML = errorHtml((res.error.message || 'RPC failed'));
                wireRetry(container);
                return;
            }
            state.rows = ((res && res.data) || []).filter(function (r) {
                return r.guild !== 'DEMO';
            });
            render(container);
        } catch (err) {
            container.innerHTML = errorHtml((err && err.message) || 'Failed to load ranking');
            wireRetry(container);
        }
    }

    function wireRetry(container) {
        var btn = document.getElementById('cross-rank-retry');
        if (btn) btn.addEventListener('click', load);
    }

    // ── Filtering & Sorting ───────────────────────────────────────────────────
    function visibleRows() {
        var q = state.query.trim().toLowerCase();
        var rows = state.rows.filter(function (r) {
            if (r.guild === 'DEMO') return false;
            if (state.guild !== 'ALL' && r.guild !== state.guild) return false;
            var sVal = r.server_number != null ? String(r.server_number) : '';
            if (state.server !== 'ALL' && sVal !== state.server) return false;

            if (state.preset === 'DAY6' && getDay6PvPScore(r) <= 0) return false;
            if (state.preset === 'SHADOW' && (r.shadow_rate == null || r.shadow_rate < 50)) return false;
            if (state.preset === 'GLORY' && getGloryDisplayVal(r) <= 0) return false;
            if (state.preset === 'ELITE' && (getDraftScore(r) == null || getDraftScore(r) < 75)) return false;

            if (!q) return true;
            var pseudoStr = String(r.pseudo || '').toLowerCase();
            var guildStr = String(r.guild || '').toLowerCase();
            var serverStr = sVal.toLowerCase();
            var formattedServer = ('#' + sVal).toLowerCase();
            return (pseudoStr.indexOf(q) !== -1 ||
                    guildStr.indexOf(q) !== -1 ||
                    serverStr.indexOf(q) !== -1 ||
                    formattedServer.indexOf(q) !== -1);
        });

        rows.sort(function (a, b) {
            var dir = state.sortDesc ? -1 : 1;
            var av, bv;

            if (state.sortKey === 'pseudo') {
                av = String(a.pseudo || '').toLowerCase();
                bv = String(b.pseudo || '').toLowerCase();
                return av.localeCompare(bv) * dir;
            }
            if (state.sortKey === 'server') {
                av = String(a.server_number != null ? a.server_number : '').toLowerCase();
                bv = String(b.server_number != null ? b.server_number : '').toLowerCase();
                if (av !== bv) return av.localeCompare(bv) * dir;
                return (getPlayerPower(b) - getPlayerPower(a));
            }
            if (state.sortKey === 'guild') {
                av = String(a.guild || '').toLowerCase();
                bv = String(b.guild || '').toLowerCase();
                if (av !== bv) return av.localeCompare(bv) * dir;
                return (getPlayerPower(b) - getPlayerPower(a));
            }
            if (state.sortKey === 'power') {
                av = getPlayerPower(a);
                bv = getPlayerPower(b);
                return (av - bv) * dir;
            }
            if (state.sortKey === 'day6' || state.sortKey === 'day6_pvp_score') {
                av = getDay6PvPScore(a);
                bv = getDay6PvPScore(b);
                if (av !== bv) return (av - bv) * dir;
                return (getPlayerPower(b) - getPlayerPower(a));
            }
            if (state.sortKey === 'glory' || state.sortKey === 'glory_total') {
                av = getGloryDisplayVal(a);
                bv = getGloryDisplayVal(b);
                if (av !== bv) return (av - bv) * dir;
                return (getPlayerPower(b) - getPlayerPower(a));
            }
            if (state.sortKey === 'shadow' || state.sortKey === 'shadow_rate') {
                av = a.shadow_rate;
                bv = b.shadow_rate;
            } else if (state.sortKey === 'svs' || state.sortKey === 'svs_rate') {
                av = a.svs_rate;
                bv = b.svs_rate;
            } else if (state.sortKey === 'gvg' || state.sortKey === 'gvg_rate') {
                av = a.gvg_rate;
                bv = b.gvg_rate;
            } else if (state.sortKey === 'global' || state.sortKey === 'global_rate') {
                av = a.global_rate;
                bv = b.global_rate;
            } else {
                // Default: draft_score
                av = getDraftScore(a);
                bv = getDraftScore(b);
            }

            var aNull = (av === null || av === undefined);
            var bNull = (bv === null || bv === undefined);
            if (aNull && bNull) return (getPlayerPower(b) - getPlayerPower(a));
            if (aNull) return 1;
            if (bNull) return -1;

            if (av !== bv) return (av - bv) * dir;

            // Tie breaker 1: Day 6 Combat
            var aDay6 = getDay6PvPScore(a);
            var bDay6 = getDay6PvPScore(b);
            if (aDay6 !== bDay6) return (aDay6 - bDay6) * dir;

            // Tie breaker 2: Shadowfront attended
            var aSh = a.shadow_attended || 0;
            var bSh = b.shadow_attended || 0;
            if (aSh !== bSh) return (aSh - bSh) * dir;

            // Tie breaker 3: Power
            return (getPlayerPower(b) - getPlayerPower(a));
        });

        return rows;
    }

    function guildList() {
        var set = [];
        state.rows.forEach(function (r) {
            if (r.guild && set.indexOf(r.guild) === -1) set.push(r.guild);
        });
        return set.sort();
    }

    function serverList() {
        var set = [];
        state.rows.forEach(function (r) {
            var s = r.server_number != null ? String(r.server_number) : '';
            if (s && set.indexOf(s) === -1) set.push(s);
        });
        return set.sort();
    }

    // ── Rendering ─────────────────────────────────────────────────────────────
    function sortArrow(key) {
        if (state.sortKey !== key) return '';
        return ' <span class="gm-dim" style="font-size:.7rem;">' + (state.sortDesc ? '▼' : '▲') + '</span>';
    }

    function headerCell(key, label, extraStyle, title) {
        return '<th data-sort="' + key + '" style="cursor:pointer; white-space:nowrap; user-select:none; ' + (extraStyle || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
            label + sortArrow(key) + '</th>';
    }

    function rowsHtml(rows) {
        if (rows.length === 0) {
            return '<tr><td colspan="10" class="gm-center" style="padding:2.5rem; color:var(--fg-dim);">' +
                '<i class="ph ph-user-minus" style="font-size:2rem; color:var(--fg-dim); margin-bottom:.5rem; display:block;"></i>' +
                'No candidate players match your migration server or guild filter.' +
            '</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(r.pseudo) : (r.pseudo ? String(r.pseudo).charAt(0).toUpperCase() : '?');
            var rank = '<span class="gm-rank-num">' + (idx + 1) + '</span>';
            var serverDisplay = formatServerDisplay(r.server_number);

            var draftScore = getDraftScore(r);
            var draftScoreStr = draftScore != null ? Math.round(draftScore) + '%' : '-';
            var day6Score = getDay6PvPScore(r);
            var day6Str = day6Score > 0 ? fmtNumber(day6Score) : '-';

            var shadowRate = r.shadow_rate;
            var shadowStr = shadowRate != null ? Math.round(shadowRate) + '%' : '-';
            var shadowRatio = r.shadow_total ? r.shadow_attended + '/' + r.shadow_total : '';

            var svsRate = r.svs_rate != null ? Math.round(r.svs_rate) + '%' : '-';
            var svsRatio = r.svs_total ? r.svs_attended + '/' + r.svs_total : '';

            var gvgRate = r.gvg_rate != null ? Math.round(r.gvg_rate) + '%' : '-';
            var gvgRatio = r.gvg_total ? r.gvg_attended + '/' + r.gvg_total : '';

            var gloryVal = getGloryDisplayVal(r);
            var gloryStr = gloryVal > 0 ? fmtNumber(gloryVal) : '-';

            var powerVal = getPlayerPower(r);
            var powerStr = fmtPower(powerVal);

            var tierBadge = '';
            if (draftScore != null) {
                if (draftScore >= 80) {
                    tierBadge = '<span class="gm-badge" style="background:rgba(16, 185, 129, 0.15); color:#34d399; border:1px solid rgba(16, 185, 129, 0.3); font-weight:800; font-size:0.65rem; padding:1px 5px; margin-left:6px;">ELITE</span>';
                } else if (draftScore >= 60) {
                    tierBadge = '<span class="gm-badge" style="background:rgba(59, 130, 246, 0.15); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.3); font-weight:700; font-size:0.65rem; padding:1px 5px; margin-left:6px;">WARRIOR</span>';
                }
            }

            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700;">' + rank + '</td>' +
                    '<td>' +
                        '<div class="gm-member-id" style="display:flex; align-items:center; gap:.75rem;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:34px; height:34px; font-size:.9rem; font-weight:700;">' + esc(initial) + '</div>' +
                            '<div style="display:flex; align-items:center;">' +
                                '<strong class="gm-member-pseudo" style="color:var(--fg); font-weight:700;">' + esc(r.pseudo) + '</strong>' +
                                tierBadge +
                            '</div>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center" data-sort="server">' +
                        '<span style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.75rem; font-variant-numeric:tabular-nums;">' + esc(serverDisplay) + '</span>' +
                    '</td>' +
                    '<td class="gm-center" data-sort="guild">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.72rem; letter-spacing:.03em;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td data-sort="power" class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums;">' + powerStr + '</td>' +
                    '<td class="gm-center" data-sort="draft_score">' +
                        '<div style="font-weight:800; font-size:0.95rem; color:' + rateColor(draftScore) + '; font-variant-numeric:tabular-nums;">' + draftScoreStr + '</div>' +
                    '</td>' +
                    '<td class="gm-right" data-sort="day6">' +
                        '<div style="font-weight:700; color:#f87171; font-variant-numeric:tabular-nums;">' + day6Str + (day6Score > 0 ? ' <span style="font-size:0.68rem; color:var(--fg-dim);">(x2)</span>' : '') + '</div>' +
                    '</td>' +
                    '<td class="gm-center" data-sort="shadow">' +
                        '<div style="font-weight:700; color:' + rateColor(shadowRate) + '; font-variant-numeric:tabular-nums;">' + shadowStr + '</div>' +
                        (shadowRatio ? '<div class="gm-dim" style="font-size:.7rem; font-variant-numeric:tabular-nums;">' + shadowRatio + '</div>' : '') +
                    '</td>' +
                    '<td class="gm-right" data-sort="glory">' +
                        '<div style="font-weight:700; color:#fbbf24; font-variant-numeric:tabular-nums;">' + gloryStr + '</div>' +
                    '</td>' +
                    '<td class="gm-center" data-sort="svs">' +
                        '<div style="font-weight:600; color:' + rateColor(r.svs_rate) + '; font-variant-numeric:tabular-nums;">' + svsRate + '</div>' +
                        (svsRatio ? '<div class="gm-dim" style="font-size:.7rem; font-variant-numeric:tabular-nums;">' + svsRatio + '</div>' : '') +
                    '</td>' +
                    '<td class="gm-center" data-sort="gvg">' +
                        '<div style="font-weight:600; color:' + rateColor(r.gvg_rate) + '; font-variant-numeric:tabular-nums;">' + gvgRate + '</div>' +
                        (gvgRatio ? '<div class="gm-dim" style="font-size:.7rem; font-variant-numeric:tabular-nums;">' + gvgRatio + '</div>' : '') +
                    '</td>' +
                '</tr>';
        });
        return html;
    }

    function render(container) {
        var rows = visibleRows();
        var guilds = guildList();
        var servers = serverList();

        var isFiltered = (state.guild !== 'ALL' || state.server !== 'ALL' || state.preset !== 'ALL' || !!state.query.trim());
        var countText = isFiltered
            ? rows.length + ' of ' + state.rows.length + ' candidates'
            : state.rows.length + ' candidates';

        var controlsHtml =
            '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">' +
                '<div class="gm-row" style="display:flex; gap:.75rem; flex-wrap:wrap; align-items:center; margin-bottom:.75rem;">' +
                    '<div class="gm-input-with-icon" style="flex:2; min-width:200px; max-width:340px;">' +
                        '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                        '<input type="text" id="cross-rank-search" class="gm-input" value="' + esc(state.query) + '" placeholder="Search candidate, server #, or guild...">' +
                    '</div>' +
                    '<select id="cross-rank-server" class="gm-input" style="width:auto; min-width:140px;">' +
                        '<option value="ALL">All Migration Servers</option>' +
                        servers.map(function (s) {
                            var label = formatServerDisplay(s);
                            return '<option value="' + esc(s) + '"' + (state.server === s ? ' selected' : '') + '>Server ' + esc(label) + '</option>';
                        }).join('') +
                    '</select>' +
                    '<select id="cross-rank-guild" class="gm-input" style="width:auto; min-width:130px;">' +
                        '<option value="ALL">All Guilds</option>' +
                        guilds.map(function (g) {
                            return '<option value="' + esc(g) + '"' + (state.guild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                        }).join('') +
                    '</select>' +
                    '<span class="gm-dim" style="margin-left:auto; font-weight:600; font-size:0.88rem;">' + esc(countText) + '</span>' +
                '</div>' +
                '<div style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center;">' +
                    '<span class="gm-dim" style="font-size:0.75rem; font-weight:700; text-transform:uppercase; margin-right:4px;">Scouting Presets:</span>' +
                    '<button type="button" class="gm-btn gm-btn-sm ' + (state.preset === 'ALL' ? 'gm-btn-primary' : 'gm-btn-ghost') + '" data-preset="ALL">All</button>' +
                    '<button type="button" class="gm-btn gm-btn-sm ' + (state.preset === 'DAY6' ? 'gm-btn-primary' : 'gm-btn-ghost') + '" data-preset="DAY6">⚔️ Day 6 PvP</button>' +
                    '<button type="button" class="gm-btn gm-btn-sm ' + (state.preset === 'SHADOW' ? 'gm-btn-primary' : 'gm-btn-ghost') + '" data-preset="SHADOW">👻 Shadowfront (≥50%)</button>' +
                    '<button type="button" class="gm-btn gm-btn-sm ' + (state.preset === 'GLORY' ? 'gm-btn-primary' : 'gm-btn-ghost') + '" data-preset="GLORY">🏆 Top Glory</button>' +
                    '<button type="button" class="gm-btn gm-btn-sm ' + (state.preset === 'ELITE' ? 'gm-btn-primary' : 'gm-btn-ghost') + '" data-preset="ELITE">👑 Elite (≥75%)</button>' +
                '</div>' +
            '</div>';

        var tableHtml =
            '<div class="gm-card glass-card" style="padding:1.25rem;">' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:50px;">#</th>' +
                            headerCell('pseudo', t('col_member') || 'Candidate') +
                            headerCell('server', 'Server', 'text-align:center;') +
                            headerCell('guild', 'Guild', 'text-align:center;') +
                            headerCell('power', 'Power', 'text-align:right;') +
                            headerCell('draft_score', '<i class="ph ph-chart-polar"></i> Draft Score', 'text-align:center;', 'Composite recruitment index (Shadowfront 35%, SvS/GvG 50%, Glory 5%)') +
                            headerCell('day6', '<i class="ph ph-sword"></i> Day 6 PvP (x2)', 'text-align:right;', 'SvS & GvG Day 6 battle combat points with 2x doubled factor') +
                            headerCell('shadow', '<i class="ph ph-ghost"></i> Shadowfront', 'text-align:center;', 'Priority 20v20 Shadowfront attendance') +
                            headerCell('glory', '<i class="ph ph-trophy"></i> Glory', 'text-align:right;', 'Cumulative Glory points accumulated') +
                            headerCell('svs', '<i class="ph ph-sword"></i> SvS (x5)', 'text-align:center;') +
                            headerCell('gvg', '<i class="ph ph-flag-banner"></i> GvG (x5)', 'text-align:center;') +
                        '</tr></thead><tbody>' + rowsHtml(rows) + '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>';

        container.innerHTML = controlsHtml + tableHtml;
        wireControls(container);
    }

    function wireControls(container) {
        var search = document.getElementById('cross-rank-search');
        if (search) {
            search.addEventListener('input', function () {
                state.query = search.value;
                render(container);
                var updatedSearch = document.getElementById('cross-rank-search');
                if (updatedSearch) {
                    updatedSearch.focus();
                    updatedSearch.setSelectionRange(updatedSearch.value.length, updatedSearch.value.length);
                }
            });
        }
        var serverSel = document.getElementById('cross-rank-server');
        if (serverSel) {
            serverSel.addEventListener('change', function () {
                state.server = serverSel.value;
                render(container);
            });
        }
        var guildSel = document.getElementById('cross-rank-guild');
        if (guildSel) {
            guildSel.addEventListener('change', function () {
                state.guild = guildSel.value;
                render(container);
            });
        }
        container.querySelectorAll('button[data-preset]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var p = btn.getAttribute('data-preset');
                if (p) {
                    state.preset = p;
                    render(container);
                }
            });
        });
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
            '<div class="gm-empty-title">' + (t('gm_settings_load_error') || 'Could not load the ranking') + '</div>' +
            '<div class="gm-empty-hint">' + esc(msg) + '</div>' +
            '<button class="gm-btn gm-btn-primary" id="cross-rank-retry" style="margin-top:.5rem;"><i class="ph ph-arrow-clockwise"></i> ' + (t('gm_settings_retry') || 'Retry') + '</button>' +
        '</div>';
    }

    window.GM_SETTINGS = {
        load: load
    };

})();
