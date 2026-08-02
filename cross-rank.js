/**
 * cross-rank.js — Classement inter-guilde (onglet « Settings », superadmin).
 * Vue consolidée de tous les joueurs de toutes les guildes : puissance,
 * taux de participation SvS / GvG / Shadowfront / Glory et taux global.
 * Source : RPC gm_cross_guild_ranking() (SECURITY DEFINER, superadmin only).
 * Chargé à la demande par app.js via window.GM_SETTINGS.load().
 */
(function () {

    var esc = (window.GM && window.GM.escapeHTML) || function (s) { return s; };
    var fmtPower = (window.GM && window.GM.formatPower) || function (n) { return String(n); };
    var t = function (k) { return window.GM_I18N ? window.GM_I18N.t(k) : k; };

    // Taux par type d'événement + taux global (dénominateur = sessions de la guilde)
    var RATE_COLUMNS = [
        { key: 'svs',    label: 'SvS',         icon: 'ph-sword' },
        { key: 'gvg',    label: 'GvG',         icon: 'ph-flag-banner' },
        { key: 'shadow', label: 'Shadowfront', icon: 'ph-ghost' },
        { key: 'glory',  label: 'Glory',       icon: 'ph-trophy' },
        { key: 'global', label: 'Overall',     icon: 'ph-chart-line' }
    ];

    var state = {
        rows: [],
        sortKey: 'global',
        sortDesc: true,
        query: '',
        guild: 'ALL'
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

    // ── Chargement : RPC superadmin-only ─────────────────────────────────────
    async function load() {
        var container = document.getElementById('cross-rank-container');
        if (!container) return;

        // Vue fraîche à chaque ouverture de l'onglet
        state.query = '';
        state.guild = 'ALL';

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
            var res = await db.rpc('gm_cross_guild_ranking');
            if (res && res.error) {
                container.innerHTML = errorHtml((res.error.message || 'RPC failed'));
                wireRetry(container);
                return;
            }
            state.rows = (res && res.data) || [];
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

    // ── Filtres & tri ────────────────────────────────────────────────────────
    function visibleRows() {
        var q = state.query.trim().toLowerCase();
        var rows = state.rows.filter(function (r) {
            if (state.guild !== 'ALL' && r.guild !== state.guild) return false;
            if (!q) return true;
            return (String(r.pseudo || '').toLowerCase().indexOf(q) !== -1
                 || String(r.guild || '').toLowerCase().indexOf(q) !== -1);
        });

        rows.sort(function (a, b) {
            var dir = state.sortDesc ? -1 : 1;
            var av, bv;
            if (state.sortKey === 'pseudo') { av = a.pseudo; bv = b.pseudo; return (av < bv ? -1 : av > bv ? 1 : 0) * dir; }
            if (state.sortKey === 'guild') { av = a.guild; bv = b.guild; return (av < bv ? -1 : av > bv ? 1 : 0) * dir; }
            if (state.sortKey === 'power') { av = a.power || 0; bv = b.power || 0; return (av - bv) * dir; }
            av = a[state.sortKey + '_rate'];
            bv = b[state.sortKey + '_rate'];
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            return (av - bv) * dir;
        });
        return rows;
    }

    function guildList() {
        var set = [];
        state.rows.forEach(function (r) {
            if (set.indexOf(r.guild) === -1) set.push(r.guild);
        });
        return set.sort();
    }

    // ── Rendu ────────────────────────────────────────────────────────────────
    function sortArrow(key) {
        if (state.sortKey !== key) return '';
        return ' <span class="gm-dim" style="font-size:.7rem;">' + (state.sortDesc ? '▼' : '▲') + '</span>';
    }

    function headerCell(key, label) {
        return '<th data-sort="' + key + '" style="cursor:pointer; white-space:nowrap; user-select:none;">' +
            label + sortArrow(key) + '</th>';
    }

    function rateCell(row, prefix) {
        var rate = row[prefix + '_rate'];
        var att = row[prefix + '_attended'];
        var tot = row[prefix + '_total'];
        if (rate === null || rate === undefined) {
            return '<td class="gm-center"><span class="gm-dim">—</span></td>';
        }
        return '<td class="gm-center">' +
            '<div style="font-weight:700; color:' + rateColor(rate) + '; font-variant-numeric:tabular-nums;">' +
                Math.round(rate) + '%' +
            '</div>' +
            '<div class="gm-dim" style="font-size:.7rem; font-variant-numeric:tabular-nums;">' + att + '/' + tot + '</div>' +
        '</td>';
    }

    function rowsHtml(rows) {
        var html = '';
        rows.forEach(function (r, idx) {
            var initial = (window.GM && window.GM.avatarInit) ? window.GM.avatarInit(r.pseudo) : (r.pseudo ? String(r.pseudo).charAt(0).toUpperCase() : '?');
            var rank = '<span class="gm-rank-num">' + (idx + 1) + '</span>';
            html +=
                '<tr style="border-bottom:1px solid var(--border-soft);">' +
                    '<td class="gm-center" style="font-weight:700;">' + rank + '</td>' +
                    '<td>' +
                        '<div class="gm-member-id" style="display:flex; align-items:center; gap:.75rem;">' +
                            '<div class="gm-avatar gm-avatar-squircle" style="width:36px; height:36px; font-size:.95rem; font-weight:700;">' + esc(initial) + '</div>' +
                            '<strong class="gm-member-pseudo" style="color:var(--fg); font-weight:700;">' + esc(r.pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-center">' +
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

        var controlsHtml =
            '<div class="gm-card gm-card-padded gm-section" style="margin-bottom:1rem;">' +
                '<div class="gm-row" style="display:flex; gap:.75rem; flex-wrap:wrap; align-items:center;">' +
                    '<div class="gm-input-with-icon" style="flex:1; min-width:220px; max-width:360px;">' +
                        '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                        '<input type="text" id="cross-rank-search" class="gm-input" placeholder="Search player or guild...">' +
                    '</div>' +
                    '<select id="cross-rank-guild" class="gm-input" style="width:auto;">' +
                        '<option value="ALL">All guilds</option>' +
                        guilds.map(function (g) {
                            return '<option value="' + esc(g) + '"' + (state.guild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
                        }).join('') +
                    '</select>' +
                    '<span class="gm-dim" style="margin-left:auto;">' + rows.length + ' players</span>' +
                '</div>' +
            '</div>';

        var tableHtml =
            '<div class="gm-card glass-card" style="padding:1.25rem;">' +
                '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
                    '<table class="gm-table" style="width:100%; border-collapse:collapse;">' +
                        '<thead><tr>' +
                            '<th class="gm-center" style="width:60px;">#</th>' +
                            headerCell('pseudo', t('col_member') || 'Member') +
                            headerCell('guild', 'Guild') +
                            headerCell('power', 'Power') +
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
