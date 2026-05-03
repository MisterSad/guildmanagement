/**
 * glory.js — Suivi de la Gloire hebdomadaire (une seule saisie par semaine).
 * Pas de notion de session ici : Glory reste indexée par week_start uniquement.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };
    var fmt = window.RAD ? window.RAD.formatNumber : function (n) { return String(n); };

    window.RAD_GLORY = { load: loadGlory };

    async function loadGlory() {
        if (!db) return;
        var week     = window.RAD.getWeekStart();
        var prevWeek = window.RAD.getPrevWeekStart(week);

        var [membersRes, currRes, prevRes] = await Promise.all([
            db.from('guild_members').select('pseudo').order('pseudo', { ascending: true }),
            db.from('event_participants').select('pseudo,score').eq('event_name', 'Glory').eq('week_start', week),
            db.from('event_participants').select('pseudo,score').eq('event_name', 'Glory').eq('week_start', prevWeek)
        ]);

        var members  = (membersRes.data || []).map(function (m) { return m.pseudo; });
        var currMap  = {};
        var prevMap  = {};
        (currRes.data || []).forEach(function (r) { currMap[r.pseudo] = r.score; });
        (prevRes.data || []).forEach(function (r) { prevMap[r.pseudo] = r.score; });

        var existing = new Set(Object.keys(currMap));
        var toInsert = members
            .filter(function (p) { return !existing.has(p); })
            .map(function (p) { return { event_name: 'Glory', week_start: week, pseudo: p, participated: 1, score: null }; });

        if (toInsert.length > 0) {
            await db.from('event_participants').insert(toInsert);
            toInsert.forEach(function (item) { currMap[item.pseudo] = null; });
        }

        renderGlory(members, currMap, prevMap, week);
    }

    function renderGlory(members, currMap, prevMap, week) {
        var area = document.querySelector('#event-glory .event-participants-area');
        if (!area) return;

        if (!members.length) {
            area.innerHTML = '<div class="empty-state"><i class="ph-duotone ph-ghost"></i><p>' + t('empty_members') + '</p></div>';
            return;
        }

        var totalGlory = Object.values(currMap).reduce(function (s, v) { return s + (v || 0); }, 0);

        var html =
            '<div class="gm-row" style="gap:.5rem; margin-bottom:1rem; flex-wrap:wrap; justify-content:space-between;">' +
                '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap;">' +
                    '<span class="gm-chip"><i class="ph-fill ph-users"></i> ' + members.length + ' ' + t('event_total') + '</span>' +
                    '<span class="gm-chip gm-chip-accent"><i class="ph-fill ph-trophy"></i> ' + t('glory_total') + ' <span class="gm-mono total-glory-val">' + fmt(totalGlory) + '</span></span>' +
                '</div>' +
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
            var initial = window.RAD.avatarInit(pseudo);

            html +=
                '<tr class="participant-row" data-pseudo="' + esc(pseudo) + '">' +
                    '<td data-label="' + t('col_member') + '">' +
                        '<div class="gm-row" style="gap:.6rem;">' +
                            '<div class="gm-avatar">' + esc(initial) + '</div>' +
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
            window.RAD.attachNumberFormatter(inp);
            var timer;
            inp.addEventListener('input', function () {
                var prev = inp.getAttribute('data-prev');
                var curr = window.RAD.parseNumber(inp.value);
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
        var c = typeof curr === 'number' ? curr : window.RAD.parseNumber(curr);
        var p = typeof prev === 'number' ? prev : parseInt(prev, 10);
        if (c === null || isNaN(p) || p === 0) return '<span class="gm-dim">—</span>';
        var diff = c - p;
        var pct = (diff / p) * 100;

        var cls = pct > 0 ? 'gm-chip-success' : pct < 0 ? 'gm-chip-danger' : '';
        var sign = pct > 0 ? '+' : '';
        return '<span class="gm-chip ' + cls + '">' + sign + pct.toFixed(1) + '%</span>';
    }

    function updateTotal(area) {
        var total = 0;
        area.querySelectorAll('.glory-input').forEach(function (inp) {
            var n = window.RAD.parseNumber(inp.value);
            total += (n || 0);
        });
        var valSpan = area.querySelector('.total-glory-val');
        if (valSpan) valSpan.textContent = fmt(total);
    }

    async function saveGlory(pseudo, value, week, icon) {
        if (!db) return;
        try {
            var scoreVal = (value === null || value === '') ? null : (typeof value === 'number' ? value : window.RAD.parseNumber(value));
            var res = await db.from('event_participants')
                .update({ score: scoreVal, participated: 1 })
                .eq('event_name', 'Glory').eq('week_start', week).eq('pseudo', pseudo);
            if (res.error) throw res.error;
            if (icon) icon.classList.add('hidden');
        } catch (err) {
            console.error('saveGlory', err);
            if (icon) icon.classList.add('hidden');
            window.RAD.showToast(t('toast_err_generic') + ' Glory', 'error');
        }
    }

})();
