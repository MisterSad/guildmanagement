/**
 * glory.js — Suivi de la Gloire hebdomadaire (une seule saisie par semaine).
 * Pas de notion de session ici : Glory reste indexée par week_start uniquement.
 */
(function () {

    var db  = window.RAD ? window.RAD.db : null;
    var t   = window.RAD ? window.RAD.t  : function (k) { return k; };
    var esc = window.RAD ? window.RAD.escapeHTML : function (s) { return s; };

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
        var hasPrev    = Object.keys(prevMap).length > 0;

        var html =
            '<div class="event-stats">' +
                '<span class="stat-chip"><i class="ph-fill ph-users"></i> ' + members.length + ' ' + t('event_total') + '</span>' +
                '<span class="stat-chip accent"><i class="ph-fill ph-trophy"></i> ' + t('glory_total') + ' <span class="total-glory-val">' + totalGlory + '</span></span>' +
                (hasPrev ? '<span class="stat-chip muted"><i class="ph-fill ph-clock-counter-clockwise"></i> ' + t('glory_vs_prev') + '</span>' : '') +
            '</div>' +
            '<div class="event-search-bar">' +
                '<input type="text" class="glory-search-input" placeholder="' + t('search_placeholder') + '">' +
            '</div>' +
            '<div class="participants-table-wrap">' +
            '<table class="participants-table"><thead><tr>' +
                '<th>' + t('col_member') + '</th>' +
                '<th class="center">' + t('glory_prev_week') + '</th>' +
                '<th class="center">' + t('glory_this_week') + '</th>' +
                '<th class="center">' + t('glory_input') + '</th>' +
                '<th class="center">' + t('glory_evolution_pct') + '</th>' +
            '</tr></thead><tbody>';

        members.forEach(function (pseudo) {
            var curr = currMap[pseudo] != null ? currMap[pseudo] : '';
            var prev = prevMap[pseudo] != null ? prevMap[pseudo] : null;

            html +=
                '<tr class="participant-row" data-pseudo="' + esc(pseudo) + '">' +
                    '<td class="pseudo-cell"><i class="ph-fill ph-game-controller text-accent"></i> ' + esc(pseudo) + '</td>' +
                    '<td class="center glory-prev-val">' +
                        (prev !== null ? '<span class="glory-prev">' + prev + '</span>' : '<span class="glory-na">—</span>') +
                    '</td>' +
                    '<td class="center glory-curr-val">' +
                        (curr !== '' ? '<span>' + curr + '</span>' : '<span class="glory-na">—</span>') +
                    '</td>' +
                    '<td class="score-cell">' +
                        '<div class="glory-input-wrapper">' +
                            '<input type="number" min="0" class="score-input glory-input"' +
                                ' value="' + curr + '" placeholder="0"' +
                                ' data-pseudo="' + esc(pseudo) + '"' +
                                ' data-prev="' + (prev !== null ? prev : '') + '">' +
                            '<i class="ph ph-circle-notch ph-spin saving-icon hidden"></i>' +
                        '</div>' +
                    '</td>' +
                    '<td class="center glory-pct-cell">' +
                        buildEvolutionPctBadge(curr, prev) +
                    '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
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
            var timer;
            inp.addEventListener('input', function () {
                var prev = inp.getAttribute('data-prev');
                var curr = inp.value;
                var row  = inp.closest('tr');

                var currCell = row.querySelector('.glory-curr-val');
                if (currCell) {
                    currCell.innerHTML = curr !== '' ? '<span>' + curr + '</span>' : '<span class="glory-na">—</span>';
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
                    saveGlory(inp.getAttribute('data-pseudo'), inp.value, week, icon);
                }, 700);
            });
        });
    }

    function buildEvolutionPctBadge(curr, prev) {
        if (curr === '' || prev === null || prev === 0) return '<span class="glory-na">—</span>';
        var c = parseInt(curr, 10);
        var p = parseInt(prev, 10);
        var diff = c - p;
        var pct = (diff / p) * 100;

        var cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
        var sign = pct > 0 ? '+' : '';
        return '<span class="glory-delta ' + cls + '">' + sign + pct.toFixed(1) + '%</span>';
    }

    function updateTotal(area) {
        var total = 0;
        area.querySelectorAll('.glory-input').forEach(function (inp) {
            total += (parseInt(inp.value, 10) || 0);
        });
        var valSpan = area.querySelector('.total-glory-val');
        if (valSpan) valSpan.textContent = total;
    }

    async function saveGlory(pseudo, value, week, icon) {
        if (!db) return;
        try {
            var scoreVal = value === '' ? null : parseInt(value, 10);
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
