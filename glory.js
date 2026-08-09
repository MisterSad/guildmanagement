/**
 * glory.js — Suivi de la Gloire hebdomadaire (une seule saisie par semaine).
 * Pas de notion de session ici : Glory reste indexée par week_start uniquement.
 */
(function () {

    function getDb() { return (window.GM && window.GM.db) ? window.GM.db : null; }
    var t   = window.GM ? window.GM.t  : function (k) { return k; };
    var esc = window.GM ? window.GM.escapeHTML : function (s) { return s; };
    var fmt = window.GM ? window.GM.formatNumber : function (n) { return String(n); };

    window.GM_GLORY = { load: loadGlory };

    async function loadGlory() {
        var db = getDb();
        if (!db) return;
        var week = window.GM.getWeekStart();
        try {
            var prevWeek = window.GM.getPrevWeekStart(week);
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';

            var [membersRes, currRes, prevRes] = await Promise.all([
                db.from('guild_members').select('pseudo').eq('guild', currentG).order('pseudo', { ascending: true }),
                db.from('event_participants').select('pseudo,score').eq('guild', currentG).eq('event_name', 'Glory').eq('week_start', week),
                db.from('event_participants').select('pseudo,score').eq('guild', currentG).eq('event_name', 'Glory').eq('week_start', prevWeek)
            ]);

            var members  = (membersRes.data || []).map(function (m) { return m.pseudo; });
            var currMap  = {};
            var prevMap  = {};
            (currRes.data || []).forEach(function (r) { currMap[r.pseudo] = r.score; });
            (prevRes.data || []).forEach(function (r) { prevMap[r.pseudo] = r.score; });

            var existing = new Set(Object.keys(currMap));
            var toInsert = members
                .filter(function (p) { return !existing.has(p); })
                .map(function (p) { return { guild: currentG, event_name: 'Glory', week_start: week, pseudo: p, participated: 1, score: null }; });

            if (toInsert.length > 0 && window.GM && window.GM.canWriteGuild && window.GM.canWriteGuild()) {
                try {
                    await db.from('event_participants').insert(toInsert);
                } catch (insertErr) {
                    console.warn('Glory insert warning', insertErr);
                }
                toInsert.forEach(function (item) { currMap[item.pseudo] = null; });
            }

            members.sort(function (a, b) {
                var valA = prevMap[a] != null ? (typeof prevMap[a] === 'number' ? prevMap[a] : parseInt(prevMap[a], 10)) : -1;
                var valB = prevMap[b] != null ? (typeof prevMap[b] === 'number' ? prevMap[b] : parseInt(prevMap[b], 10)) : -1;
                if (isNaN(valA)) valA = -1;
                if (isNaN(valB)) valB = -1;
                if (valB !== valA) {
                    return valB - valA;
                }
                return a.localeCompare(b);
            });

            renderGlory(members, currMap, prevMap, week);
        } catch (err) {
            console.error('loadGlory error:', err);
            renderGlory([], {}, {}, week);
        }
    }

    function renderGlory(members, currMap, prevMap, week) {
        var area = document.querySelector('#event-glory .event-participants-area');
        if (!area) return;

        if (!members.length) {
            area.innerHTML = '<div class="gm-empty"><i class="ph-duotone ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_members') + '</div></div>';
            return;
        }

        var totalGlory = Object.values(currMap).reduce(function (s, v) { return s + (v || 0); }, 0);

        var html =
            '<div class="gm-stat-grid" style="margin-bottom: 1.5rem;">' +
                '<div class="gm-stat-tile stat-theme-lime">' +
                    '<div class="gm-task-icon-squircle"><i class="ph ph-users"></i></div>' +
                    '<div class="gm-stat-label">' + t('event_total') + '</div>' +
                    '<div class="gm-stat-val">' + fmt(members.length) + '</div>' +
                    '<div class="gm-stat-meta">Active Members Tracked</div>' +
                '</div>' +
                '<div class="gm-stat-tile stat-theme-mint">' +
                    '<div class="gm-task-icon-squircle"><i class="ph ph-trophy"></i></div>' +
                    '<div class="gm-stat-label">' + t('glory_total') + '</div>' +
                    '<div class="gm-stat-val total-glory-val">' + fmt(totalGlory) + '</div>' +
                    '<div class="gm-stat-meta">Guild Total This Week</div>' +
                '</div>' +
            '</div>' +
            '<div class="gm-section-head" style="margin-bottom: 1rem; flex-wrap: wrap;">' +
                '<div class="gm-section-title"><i class="ph ph-list-numbers"></i> Members Glory Log</div>' +
                '<div class="gm-input-with-icon" style="min-width: 220px; max-width: 320px;">' +
                    '<i class="ph ph-magnifying-glass gm-icon"></i>' +
                    '<input type="text" class="gm-input glory-search-input" placeholder="' + t('search_placeholder') + '">' +
                '</div>' +
            '</div>' +
            '<div class="gm-table-wrap">' +
            '<div class="gm-table-scroll">' +
            '<table class="gm-table gm-resp-table"><thead><tr>' +
                '<th>' + t('col_member') + '</th>' +
                '<th class="gm-right">' + t('glory_prev_week') + '</th>' +
                '<th class="gm-right">' + t('glory_input') + '</th>' +
                '<th class="gm-right">' + t('glory_evolution_pct') + '</th>' +
            '</tr></thead><tbody>';

        members.forEach(function (pseudo) {
            var curr = currMap[pseudo] != null ? currMap[pseudo] : '';
            var prev = prevMap[pseudo] != null ? prevMap[pseudo] : null;
            var initial = window.GM.avatarInit(pseudo);

            html +=
                '<tr class="participant-row" data-pseudo="' + esc(pseudo) + '">' +
                    '<td data-label="' + t('col_member') + '">' +
                        '<div class="gm-member-id">' +
                            '<div class="gm-avatar gm-avatar-squircle">' + esc(initial) + '</div>' +
                            '<strong>' + esc(pseudo) + '</strong>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-right gm-num gm-dim glory-prev-val" data-label="' + t('glory_prev_week') + '">' +
                        (prev !== null ? fmt(prev) : '—') +
                    '</td>' +
                    '<td class="gm-right" data-label="' + t('glory_input') + '">' +
                        '<div class="glory-input-wrapper" style="position:relative; display:inline-flex; align-items:center;">' +
                            '<input type="text" inputmode="numeric" class="gm-glory-input glory-input"' +
                                ' value="' + (curr !== '' ? fmt(curr) : '') + '" placeholder="0"' +
                                ' data-pseudo="' + esc(pseudo) + '"' +
                                ' data-prev="' + (prev !== null ? prev : '') + '">' +
                            '<i class="ph ph-circle-notch ph-spin saving-icon hidden" style="position:absolute; right:.6rem;"></i>' +
                        '</div>' +
                    '</td>' +
                    '<td class="gm-right glory-pct-cell" data-label="' + t('glory_evolution_pct') + '">' +
                        buildEvolutionPctBadge(curr, prev) +
                    '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div></div>';
        area.innerHTML = html;

        var searchInput = area.querySelector('.glory-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                var q = e.target.value.toLowerCase();
                area.querySelectorAll('.participant-row').forEach(function (row) {
                    var pseudo = row.getAttribute('data-pseudo').toLowerCase();
                    row.style.display = pseudo.indexOf(q) !== -1 ? '' : 'none';
                });
            });
        }

        area.querySelectorAll('.glory-input').forEach(function (inp) {
            window.GM.attachNumberFormatter(inp);
            var timer;
            inp.addEventListener('input', function () {
                var prev = inp.getAttribute('data-prev');
                var curr = window.GM.parseNumber(inp.value);
                var row  = inp.closest('tr');

                var currCell = row.querySelector('.glory-curr-val');
                if (currCell) {
                    currCell.innerHTML = curr !== null ? '<span>' + fmt(curr) + '</span>' : '<span class="glory-na">—</span>';
                }

                var pctCell = row.querySelector('.glory-pct-cell');
                if (pctCell) {
                    pctCell.innerHTML = buildEvolutionPctBadge(curr, prev === '' ? null : parseInt(prev, 10));
                }

                updateTotal(area);

                var icon = row.querySelector('.saving-icon');
                if (icon) icon.classList.remove('hidden');

                clearTimeout(timer);
                timer = setTimeout(function () {
                    saveGlory(inp.getAttribute('data-pseudo'), curr, week, icon);
                }, 700);
            });
        });
    }

    function buildEvolutionPctBadge(curr, prev) {
        if (curr === null || curr === '' || prev === null || prev === 0) return '<span class="gm-dim">—</span>';
        var c = typeof curr === 'number' ? curr : window.GM.parseNumber(curr);
        var p = typeof prev === 'number' ? prev : parseInt(prev, 10);
        if (c === null || isNaN(p) || p === 0) return '<span class="gm-dim">—</span>';
        var diff = c - p;
        var pct = (diff / p) * 100;

        var cls = pct > 0 ? 'gm-chip-success' : pct < 0 ? 'gm-chip-danger' : '';
        var sign = pct > 0 ? '+' : '';
        return '<span class="gm-chip ' + cls + '" style="font-family: var(--font-display); font-weight: 700; font-size: 0.82rem; padding: 2px 10px; border-radius: var(--radius-pill);">' + sign + pct.toFixed(1) + '%</span>';
    }

    function updateTotal(area) {
        var total = 0;
        area.querySelectorAll('.glory-input').forEach(function (inp) {
            var n = window.GM.parseNumber(inp.value);
            total += (n || 0);
        });
        var valSpan = area.querySelector('.total-glory-val');
        if (valSpan) valSpan.textContent = fmt(total);
    }

    async function saveGlory(pseudo, value, week, icon) {
        var db = getDb();
        if (!db) return;
        try {
            var currentG = window.GM ? window.GM.getActiveGuild() : 'ALPHA';
            var scoreVal = (value === null || value === '') ? 0 : (typeof value === 'number' ? value : (window.GM.parseNumber(value) || 0));
            var rpcRes = await db.rpc('gm_upsert_player_glory', {
                p_guild: currentG,
                p_pseudo: pseudo,
                p_week_start: week,
                p_glory: scoreVal
            });
            if (rpcRes && rpcRes.error) throw rpcRes.error;
            if (icon) icon.classList.add('hidden');
        } catch (err) {
            console.error('saveGlory', err);
            if (icon) icon.classList.add('hidden');
            window.GM.showToast(t('toast_err_generic') + ' Glory', 'error');
        }
    }

})();
