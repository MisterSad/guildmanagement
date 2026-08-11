/**
 * cross-rank.js — Classement inter-guilde & Mercato (onglet « Draft », superadmin).
 * Vue consolidée de tous les joueurs de toutes les guildes et serveurs : puissance,
 * guilde, serveur, et taux de participation pondéré selon les coefficients des événements
 * (SvS coef 5, GvG coef 5, Shadowfront coef 3, DTR coef 2, Arms Race coef 2).
 * Source : RPC gm_cross_guild_ranking() (SECURITY DEFINER, superadmin only).
 * Chargé à la demande par app.js via window.GM_SETTINGS.load().
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var fmtPower = (window.GM && window.GM.formatPower) || function (n) { return String(n); };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    // Colonnes d'événements avec leurs coefficients respectifs
    var RATE_COLUMNS = [
        { key: 'svs',    label: 'SvS (x5)',         icon: 'ph-sword' },
        { key: 'gvg',    label: 'GvG (x5)',         icon: 'ph-flag-banner' },
        { key: 'shadow', label: 'Shadowfront (x3)', icon: 'ph-ghost' },
        { key: 'dtr',    label: 'DTR (x2)',         icon: 'ph-shield' },
        { key: 'arms',   label: 'Arms Race (x2)',   icon: 'ph-target' },
        { key: 'global', label: 'Overall',          icon: 'ph-chart-line' }
    ];

    var state = {
        rows: [],
        sortKey: 'global',
        sortDesc: true,
        query: '',
        guild: 'ALL',
        server: 'ALL'
    };

    function getDb() {
        return (window.GM && window.GM.db) ? window.GM.db : null;
    }

    function rateColor(rate) {
        if (rate === null || rate === undefined) return '';
        if (rate >= 60) return 'var(--success)';
        if (rate >= 35) return 'var(--warning)';
        return 'var(--error)';
    }

    function formatServerDisplay(rawServer) {
        if (!rawServer) return '-';
        var s = String(rawServer).trim();
        if (s.indexOf('#') === 0) return s;
        return '#' + s;
    }

    function getWeightedGlobalRate(r) {
        if (r.global_rate !== null && r.global_rate !== undefined) {
            return r.global_rate;
        }
        var totalWeight = 0;
        var weightedSum = 0;

        if (r.svs_total > 0 && r.svs_rate != null) {
            totalWeight += 5;
            weightedSum += 5 * r.svs_rate;
        }
        if (r.gvg_total > 0 && r.gvg_rate != null) {
            totalWeight += 5;
            weightedSum += 5 * r.gvg_rate;
        }
        if (r.shadow_total > 0 && r.shadow_rate != null) {
            totalWeight += 3;
            weightedSum += 3 * r.shadow_rate;
        }
        if (r.dtr_total > 0 && r.dtr_rate != null) {
            totalWeight += 2;
            weightedSum += 2 * r.dtr_rate;
        }
        if (r.arms_total > 0 && r.arms_rate != null) {
            totalWeight += 2;
            weightedSum += 2 * r.arms_rate;
        }
        if (totalWeight === 0) return null;
        return Math.round((weightedSum / totalWeight) * 10) / 10;
    }

    // ── Chargement : RPC superadmin-only ─────────────────────────────────────
    async function load() {
        var container = document.getElementById('cross-rank-container');
        if (!container) return;

        // Vue fraîche à chaque ouverture de l'onglet
        state.query = '';
        state.guild = 'ALL';
        state.server = 'ALL';
        state.sortKey = 'global';
        state.sortDesc = true;

        var db = getDb();
        if (!db) {
            container.innerHTML = loadingHtml();
            return;
        }

        // Garde client : onglet réservé au superadmin (la RPC garde aussi côté serveur)
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
            // Utilisation de .range(0, 99999) pour s'affranchir du cap par défaut de 1000 lignes de PostgREST
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

    // ── Filtres & tri (par régularité & volume pondéré) ──────────────────────
    function visibleRows() {
        var q = state.query.trim().toLowerCase();
        var rows = state.rows.filter(function (r) {
            if (r.guild === 'DEMO') return false;
            if (state.guild !== 'ALL' && r.guild !== state.guild) return false;
            var sVal = r.server_number != null ? String(r.server_number) : '';
            if (state.server !== 'ALL' && sVal !== state.server) return false;
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
                return (b.power || 0) - (a.power || 0);
            }
            if (state.sortKey === 'guild') {
                av = String(a.guild || '').toLowerCase();
                bv = String(b.guild || '').toLowerCase();
                if (av !== bv) return av.localeCompare(bv) * dir;
                return (b.power || 0) - (a.power || 0);
            }
            if (state.sortKey === 'power') {
                av = a.power || 0;
                bv = b.power || 0;
                return (av - bv) * dir;
            }

            // Tri par taux (% de participation) avec départage par régularité
            if (state.sortKey === 'global') {
                av = getWeightedGlobalRate(a);
                bv = getWeightedGlobalRate(b);
            } else {
                av = a[state.sortKey + '_rate'];
                bv = b[state.sortKey + '_rate'];
            }

            var aNull = (av === null || av === undefined);
            var bNull = (bv === null || bv === undefined);
            if (aNull && bNull) return (b.power || 0) - (a.power || 0);
            if (aNull) return 1;
            if (bNull) return -1;

            if (av !== bv) return (av - bv) * dir;

            // Départage 1 : Nombre de présences réelles (plus de matchs joués = plus régulier)
            var aAtt = a[state.sortKey + '_attended'] || a.global_attended || 0;
            var bAtt = b[state.sortKey + '_attended'] || b.global_attended || 0;
            if (aAtt !== bAtt) return (aAtt - bAtt) * dir;

            // Départage 2 : Nombre total d'événements
            var aTot = a[state.sortKey + '_total'] || a.global_total || 0;
            var bTot = b[state.sortKey + '_total'] || b.global_total || 0;
            if (aTot !== bTot) return (aTot - bTot) * dir;

            // Départage 3 : Puissance de combat
            return (b.power || 0) - (a.power || 0);
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

    // ── Rendu ────────────────────────────────────────────────────────────────
    function sortArrow(key) {
        if (state.sortKey !== key) return '';
        return ' <span class="gm-dim" style="font-size:.7rem;">' + (state.sortDesc ? '▼' : '▲') + '</span>';
    }

    function headerCell(key, label, extraStyle) {
        return '<th data-sort="' + key + '" style="cursor:pointer; white-space:nowrap; user-select:none; ' + (extraStyle || '') + '">' +
            label + sortArrow(key) + '</th>';
    }

    function rateCell(row, prefix) {
        var rate = (prefix === 'global') ? getWeightedGlobalRate(row) : row[prefix + '_rate'];
        var att = row[prefix + '_attended'];
        var tot = row[prefix + '_total'];
        if (rate === null || rate === undefined) {
            return '<td class="gm-center"><span class="gm-dim">-</span></td>';
        }
        return '<td class="gm-center">' +
            '<div style="font-weight:700; color:' + rateColor(rate) + '; font-variant-numeric:tabular-nums;">' +
                Math.round(rate) + '%' +
            '</div>' +
            '<div class="gm-dim" style="font-size:.7rem; font-variant-numeric:tabular-nums;">' + att + '/' + tot + '</div>' +
        '</td>';
    }

    function rowsHtml(rows) {
        if (rows.length === 0) {
            return '<tr><td colspan="11" class="gm-center" style="padding:2.5rem; color:var(--fg-dim);">' +
                '<i class="ph ph-user-minus" style="font-size:2rem; color:var(--fg-dim); margin-bottom:.5rem; display:block;"></i>' +
                'No players match your server or guild filter.' +
            '</td></tr>';
        }
        var html = '';
        rows.forEach(function (r, idx) {
            var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(r.pseudo) : (r.pseudo ? String(r.pseudo).charAt(0).toUpperCase() : '?');
            var rank = '<span class="gm-rank-num">' + (idx + 1) + '</span>';
            var serverDisplay = formatServerDisplay(r.server_number);

            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700;">' + rank + '</td>' +
                    '<td>' +
                        '<div class="gm-member-id" style="display:flex; align-items:center; gap:.75rem;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:36px; height:36px; font-size:.95rem; font-weight:700;">' + esc(initial) + '</div>' +
                            '<strong class="gm-member-pseudo" style="color:var(--fg); font-weight:700;">' + esc(r.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center" data-sort="server">' +
                        '<span style="background:rgba(59, 130, 246, 0.12); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.25); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.75rem; font-variant-numeric:tabular-nums;">' + esc(serverDisplay) + '</span>' +
                    '</td>' +
                    '<td class="gm-center" data-sort="guild">' +
                        '<span style="background:var(--accent-soft); color:var(--accent); border-radius:6px; padding:2px 8px; font-weight:700; font-size:.72rem; letter-spacing:.03em;">' + esc(r.guild) + '</span>' +
                    '</td>' +
                    '<td data-sort="power" class="gm-right" style="font-weight:700; font-variant-numeric:tabular-nums;">' + fmtPower(r.power) + '</td>' +
                    RATE_COLUMNS.map(function (c) { return rateCell(r, c.key); }).join('') +
                '</tr>';
        });
        return html;
    }

    function render(container) {
        var rows = visibleRows();
        var guilds = guildList();
        var servers = serverList();

        var isFiltered = (state.guild !== 'ALL' || state.server !== 'ALL' || !!state.query.trim());
        var countText = isFiltered
            ? rows.length + ' of ' + state.rows.length + ' players'
            : state.rows.length + ' players';

        var controlsHtml =
            '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">' +
                '<div class="gm-row" style="display:flex; gap:.75rem; flex-wrap:wrap; align-items:center;">' +
                    '<div class="gm-input-with-icon" style="flex:1; min-width:200px; max-width:320px;">' +
                        '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                        '<input type="text" id="cross-rank-search" class="gm-input" value="' + esc(state.query) + '" placeholder="Search player, guild, server...">' +
                    '</div>' +
                    '<select id="cross-rank-server" class="gm-input" style="width:auto; min-width:140px;">' +
                        '<option value="ALL">All servers</option>' +
                        servers.map(function (s) {
                            var label = formatServerDisplay(s);
                            return '<option value="' + esc(s) + '"' + (state.server === s ? ' selected' : '') + '>Server ' + esc(label) + '</option>';
                        }).join('') +
                    '</select>' +
                    '<select id="cross-rank-guild" class="gm-input" style="width:auto; min-width:130px;">' +
                        '<option value="ALL">All guilds</option>' +
                        guilds.map(function (g) {
                            return '<option value="' + esc(g) + '"' + (state.guild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                        }).join('') +
                    '</select>' +
                    '<span class="gm-dim" style="margin-left:auto; font-weight:600; font-size:0.88rem;">' + esc(countText) + '</span>' +
                '</div>' +
            '</div>';

        var tableHtml =
            '<div class="gm-card glass-card" style="padding:1.25rem;">' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:60px;">#</th>' +
                            headerCell('pseudo', t('col_member') || 'Member') +
                            headerCell('server', 'Server', 'text-align:center;') +
                            headerCell('guild', 'Guild', 'text-align:center;') +
                            headerCell('power', 'Power', 'text-align:right;') +
                            RATE_COLUMNS.map(function (c) {
                                return '<th data-sort="' + c.key + '" class="gm-center" style="cursor:pointer; white-space:nowrap; user-select:none;" title="' + c.label + '">' +
                                    '<i class="ph ' + c.icon + '"></i> ' + c.label + sortArrow(c.key) + '</th>';
                            }).join('') +
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
